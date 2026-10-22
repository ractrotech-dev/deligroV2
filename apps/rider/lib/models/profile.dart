/// The rider's profile and documents: `GET /api/rider/profile` and friends
/// (src/lib/data-access/rider-profile.ts, src/lib/rider/profile-rules.ts).
///
/// Everything a rider typed (names, addresses, relations) is kept exactly as
/// the server sent it: no ASCII assumptions, no case folding.
library;

String? _str(Object? v) => v is String && v.isNotEmpty ? v : null;

Map<String, dynamic> _map(Object? v) =>
    v is Map ? Map<String, dynamic>.from(v) : const <String, dynamic>{};

/// Where the rider stands with Deligro's verification.
enum Verification {
  unverified('Not verified'),
  pending('Waiting for Deligro'),
  verified('Verified'),
  rejected('Needs attention');

  const Verification(this.label);
  final String label;

  static Verification parse(Object? v) => switch (v) {
    'pending' => Verification.pending,
    'verified' => Verification.verified,
    'rejected' => Verification.rejected,
    _ => Verification.unverified,
  };
}

/// `profile` in `GET /api/rider/me`: enough for the Home badge and the red dot
/// on More. Null on a server without migration 0086.
class ProfileStatus {
  const ProfileStatus({
    required this.verification,
    this.documentsComplete = false,
    this.needsAttention = false,
  });

  final Verification verification;
  final bool documentsComplete;
  final bool needsAttention;

  static ProfileStatus? fromJson(Object? v) {
    if (v is! Map) return null;
    final j = Map<String, dynamic>.from(v);
    return ProfileStatus(
      verification: Verification.parse(j['verification']),
      documentsComplete: j['documentsComplete'] == true,
      needsAttention: j['needsAttention'] == true,
    );
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/// What a document type asks of the rider.
class DocType {
  const DocType(
    this.id,
    this.label, {
    this.number = NumberRule.none,
    this.expiry = false,
    this.hint,
  });

  final String id;
  final String label;
  final NumberRule number;

  /// The upload must carry an expiry date (licence, insurance, PUC).
  final bool expiry;
  final String? hint;
}

enum NumberRule { none, optional, required }

const docTypes = <DocType>[
  DocType('aadhaar', 'Aadhaar', number: NumberRule.required, hint: '12 digits. Deligro keeps only the last 4.'),
  DocType('driving_licence', 'Driving licence', number: NumberRule.required, expiry: true),
  DocType('photo', 'Photo'),
  DocType('pan', 'PAN card', number: NumberRule.required, hint: 'Like ABCDE1234F'),
  DocType('vehicle_rc', 'Vehicle RC', number: NumberRule.optional),
  DocType('insurance', 'Insurance', number: NumberRule.optional, expiry: true),
  DocType('puc', 'PUC certificate', number: NumberRule.optional, expiry: true),
];

DocType? docTypeOf(String id) {
  for (final t in docTypes) {
    if (t.id == id) return t;
  }
  return null;
}

String docTypeLabel(String id) => docTypeOf(id)?.label ?? id;

/// Needed for verification whoever owns the vehicle.
const requiredDocTypes = ['aadhaar', 'driving_licence', 'photo'];

/// Needed only when the rider rides their own vehicle (Deligro supplies the EV bike).
const vehicleDocTypes = ['vehicle_rc', 'insurance', 'puc'];

List<String> requiredDocTypesFor(String owner) => owner == 'rider'
    ? [...requiredDocTypes, ...vehicleDocTypes]
    : [...requiredDocTypes];

class RiderDocument {
  const RiderDocument({
    required this.id,
    required this.type,
    this.numberMasked,
    this.expiresOn,
    this.daysLeft,
    required this.status,
    this.remarks,
    this.uploadedAt,
  });

  final String id;
  final String type;

  /// `XXXX-XXXX-1234` for Aadhaar, `XXXX1234` otherwise. Never a full number.
  final String? numberMasked;

  /// `YYYY-MM-DD`.
  final String? expiresOn;

  /// Whole days from today (IST) to [expiresOn]; negative once past.
  final int? daysLeft;

  /// `pending`, `verified`, `rejected` or `expired`.
  final String status;
  final String? remarks;
  final DateTime? uploadedAt;

  bool get expired => status == 'expired' || (daysLeft != null && daysLeft! < 0);
  bool get rejected => status == 'rejected';
  bool get verified => status == 'verified' && !expired;

  /// Expires within 30 days (and has not yet).
  bool get expiringSoon => !expired && daysLeft != null && daysLeft! <= 30;

  factory RiderDocument.fromJson(Map<String, dynamic> j) => RiderDocument(
    id: '${j['id']}',
    type: '${j['type']}',
    numberMasked: _str(j['numberMasked']),
    expiresOn: _str(j['expiresOn']),
    daysLeft: (j['daysLeft'] as num?)?.toInt(),
    status: '${j['status'] ?? 'pending'}',
    remarks: _str(j['remarks']),
    uploadedAt: j['uploadedAt'] is String ? DateTime.tryParse(j['uploadedAt'] as String) : null,
  );
}

/// Which required documents still need the rider, worked out from the
/// documents themselves (the same rules as the server's `documentsStatus`).
class DocumentsCheck {
  const DocumentsCheck({
    required this.required,
    required this.missing,
    required this.rejected,
    required this.expired,
    required this.awaitingReview,
  });

  final List<String> required;
  final List<String> missing;
  final List<String> rejected;
  final List<String> expired;
  final List<String> awaitingReview;

  bool get complete =>
      missing.isEmpty && rejected.isEmpty && expired.isEmpty && awaitingReview.isEmpty;

  /// The rider has something to do (waiting for Deligro is not theirs to fix).
  bool get riderToDo => missing.isNotEmpty || rejected.isNotEmpty || expired.isNotEmpty;

  factory DocumentsCheck.of(List<RiderDocument> docs, String owner) {
    final required = requiredDocTypesFor(owner);
    final missing = <String>[], rejected = <String>[], expired = <String>[], awaiting = <String>[];
    for (final type in required) {
      final d = docs.where((x) => x.type == type).firstOrNull;
      if (d == null) {
        missing.add(type);
      } else if (d.rejected) {
        rejected.add(type);
      } else if (d.expired) {
        expired.add(type);
      } else if (d.status != 'verified') {
        awaiting.add(type);
      }
    }
    return DocumentsCheck(
      required: required,
      missing: missing,
      rejected: rejected,
      expired: expired,
      awaitingReview: awaiting,
    );
  }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/// One request waiting for Deligro. [summary] is one masked line.
class PendingChange {
  const PendingChange({required this.id, required this.field, this.createdAt, this.summary});

  final String id;

  /// `full_name`, `licence`, `vehicle` or `payout_account`.
  final String field;
  final DateTime? createdAt;
  final String? summary;

  factory PendingChange.fromJson(Map<String, dynamic> j) => PendingChange(
    id: '${j['id'] ?? ''}',
    field: '${j['field']}',
    createdAt: j['createdAt'] is String ? DateTime.tryParse(j['createdAt'] as String) : null,
    summary: _str(j['summary']),
  );
}

/// A past request, with Deligro's answer (`GET .../change-requests`).
class ChangeRequestView {
  const ChangeRequestView({
    required this.id,
    required this.field,
    required this.status,
    this.createdAt,
    this.decidedAt,
    this.decisionNote,
    this.summary,
  });

  final String id;
  final String field;

  /// `pending`, `approved` or `rejected`.
  final String status;
  final DateTime? createdAt;
  final DateTime? decidedAt;
  final String? decisionNote;
  final String? summary;

  factory ChangeRequestView.fromJson(Map<String, dynamic> j) => ChangeRequestView(
    id: '${j['id']}',
    field: '${j['field']}',
    status: '${j['status'] ?? 'pending'}',
    createdAt: j['createdAt'] is String ? DateTime.tryParse(j['createdAt'] as String) : null,
    decidedAt: j['decidedAt'] is String ? DateTime.tryParse(j['decidedAt'] as String) : null,
    decisionNote: _str(j['decisionNote']),
    summary: _str(j['summary']),
  );
}

/// `change-requests` field names, and what the rider calls them.
const changeFieldLabels = {
  'full_name': 'Name',
  'licence': 'Driving licence',
  'vehicle': 'Vehicle',
  'payout_account': 'Payout account',
};

class Address {
  const Address({this.line, this.city, this.pincode});
  final String? line;
  final String? city;
  final String? pincode;

  bool get isEmpty => line == null && city == null && pincode == null;

  /// "12 MG Road, Pune 411001", whichever parts exist.
  String get oneLine {
    final cityPin = [city, pincode].whereType<String>().join(' ');
    return [line, if (cityPin.isNotEmpty) cityPin].whereType<String>().join(', ');
  }

  factory Address.fromJson(Map<String, dynamic> j) =>
      Address(line: _str(j['line']), city: _str(j['city']), pincode: _str(j['pincode']));
}

class Vehicle {
  const Vehicle({this.type, this.owner = 'deligro', this.registration});
  final String? type;

  /// `deligro` or `rider`.
  final String owner;
  final String? registration;

  factory Vehicle.fromJson(Map<String, dynamic> j) => Vehicle(
    type: _str(j['type']),
    owner: j['owner'] == 'rider' ? 'rider' : 'deligro',
    registration: _str(j['registration']),
  );
}

const vehicleTypeLabels = {
  'ev_bike': 'EV bike',
  'bike': 'Motorbike',
  'scooter': 'Scooter',
  'bicycle': 'Bicycle',
  'other': 'Other',
};

class Licence {
  const Licence({this.number, this.expiresOn});
  final String? number;
  final String? expiresOn;

  factory Licence.fromJson(Map<String, dynamic> j) =>
      Licence(number: _str(j['number']), expiresOn: _str(j['expiresOn']));
}

class EmergencyContact {
  const EmergencyContact({this.name, this.phone, this.relation});
  final String? name;
  final String? phone;
  final String? relation;

  bool get isEmpty => name == null && phone == null && relation == null;

  factory EmergencyContact.fromJson(Map<String, dynamic> j) =>
      EmergencyContact(name: _str(j['name']), phone: _str(j['phone']), relation: _str(j['relation']));
}

/// The payout account as the rider may see it: its kind and a masked number.
class PayoutAccount {
  const PayoutAccount({required this.kind, required this.masked});

  /// `bank` or `upi`.
  final String kind;
  final String masked;

  String get kindLabel => kind == 'upi' ? 'UPI' : 'Bank account';

  static PayoutAccount? fromJson(Object? v) {
    if (v is! Map) return null;
    final j = Map<String, dynamic>.from(v);
    return PayoutAccount(
      kind: j['kind'] == 'upi' ? 'upi' : 'bank',
      masked: _str(j['masked']) ?? 'XXXX',
    );
  }
}

class RiderProfile {
  const RiderProfile({
    this.riderCode,
    this.name,
    this.phone,
    this.avatarUrl,
    this.address = const Address(),
    this.vehicle = const Vehicle(),
    this.licence = const Licence(),
    this.emergency = const EmergencyContact(),
    this.payoutAccount,
    this.verification = Verification.unverified,
    this.documents = const [],
    this.pendingChanges = const [],
    this.needsAttention = false,
  });

  final String? riderCode;
  final String? name;
  final String? phone;
  final String? avatarUrl;
  final Address address;
  final Vehicle vehicle;
  final Licence licence;
  final EmergencyContact emergency;
  final PayoutAccount? payoutAccount;
  final Verification verification;
  final List<RiderDocument> documents;
  final List<PendingChange> pendingChanges;
  final bool needsAttention;

  DocumentsCheck get check => DocumentsCheck.of(documents, vehicle.owner);

  PendingChange? pendingFor(String field) =>
      pendingChanges.where((c) => c.field == field).firstOrNull;

  RiderDocument? documentOf(String type) => documents.where((d) => d.type == type).firstOrNull;

  /// `GET /api/rider/profile` answers `{ profile: {...} }`; this reads the inner map.
  factory RiderProfile.fromJson(Map<String, dynamic> j) => RiderProfile(
    riderCode: _str(j['riderCode']),
    name: _str(j['name']),
    phone: _str(j['phone']),
    avatarUrl: _str(j['avatarUrl']),
    address: Address.fromJson(_map(j['address'])),
    vehicle: Vehicle.fromJson(_map(j['vehicle'])),
    licence: Licence.fromJson(_map(j['licence'])),
    emergency: EmergencyContact.fromJson(_map(j['emergency'])),
    payoutAccount: PayoutAccount.fromJson(j['payoutAccount']),
    verification: Verification.parse(j['verification']),
    documents: [
      for (final d in (j['documents'] as List? ?? const []))
        if (d is Map) RiderDocument.fromJson(Map<String, dynamic>.from(d)),
    ],
    pendingChanges: [
      for (final c in (j['pendingChanges'] as List? ?? const []))
        if (c is Map) PendingChange.fromJson(Map<String, dynamic>.from(c)),
    ],
    needsAttention: j['needsAttention'] == true,
  );
}

/// A document's bytes fetched through its short-lived signed link. Held in
/// memory only.
class DocumentContent {
  const DocumentContent({required this.bytes, required this.isPdf});
  final List<int> bytes;
  final bool isPdf;
}
