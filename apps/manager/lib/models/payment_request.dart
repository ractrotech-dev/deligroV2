import 'package:uuid/uuid.dart';

import 'json_util.dart';
import 'vendors.dart' show PersonRef, ZoneRef;

/// Maker–checker payment requests as `/api/manager/payments/requests*` send
/// them (Phase 5 plan, "API contract"). One person asks, a different person
/// approves; the server refuses the requester (`same_person`), and the app
/// never offers them the button (`canDecide`).

enum PaymentKind {
  riderPayout('rider_payout', 'Rider payout'),
  vendorSettlement('vendor_settlement', 'Vendor settlement'),

  /// Undo a paid settlement whose transfer did not reach the vendor (0156):
  /// approving it voids the payout so its orders can be paid again.
  settlementReversal('settlement_reversal', 'Reverse a paid settlement'),
  unknown('unknown', 'Payment');

  const PaymentKind(this.wire, this.label);
  final String wire;
  final String label;

  /// About a shop's money (whole rupees, the subject is the shop).
  bool get isVendor => this == vendorSettlement || this == settlementReversal;

  static PaymentKind parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

enum PaymentStatus {
  pendingApproval('pending_approval', 'Waiting for approval'),
  approved('approved', 'Approved'),
  rejected('rejected', 'Rejected'),
  cancelled('cancelled', 'Withdrawn'),
  unknown('unknown', 'Unknown');

  const PaymentStatus(this.wire, this.label);
  final String wire;
  final String label;

  static PaymentStatus parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

enum PayMethod {
  bank('bank', 'Bank transfer'),
  upi('upi', 'UPI'),
  cash('cash', 'Cash'),
  other('other', 'Other'),
  unknown('unknown', 'Other');

  const PayMethod(this.wire, this.label);
  final String wire;
  final String label;

  static PayMethod parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);

  static const choices = [bank, upi, cash, other];
}

/// Who or what a request pays: a rider (with their code) or a shop.
class PaymentSubject {
  const PaymentSubject({required this.id, required this.name, this.code});
  factory PaymentSubject.fromJson(Map<String, dynamic>? j) =>
      PaymentSubject(id: jStrOr(j?['id']), name: jStrOr(j?['name']), code: jStr(j?['code']));
  final String id;
  final String name;
  final String? code;
}

class PaymentRequest {
  const PaymentRequest({
    required this.id,
    required this.kind,
    required this.subject,
    required this.amount,
    required this.method,
    required this.status,
    this.zone,
    this.periodEnd,
    this.salaryAmount,
    this.note,
    this.requestedBy,
    this.requestedAt,
    this.decidedBy,
    this.decidedAt,
    this.decisionNote,
    this.reference,
    this.paidOn,
    this.resultId,
    this.selfApproved = false,
    this.canDecide = false,
    this.settlementId,
  });

  factory PaymentRequest.fromJson(Map<String, dynamic> j) {
    final z = jRef(j['zone']);
    return PaymentRequest(
      id: jStrOr(j['id']),
      kind: PaymentKind.parse(j['kind']),
      subject: PaymentSubject.fromJson(jMap(j['subject'])),
      zone: z == null ? null : ZoneRef(id: z.id, name: z.name),
      amount: jDouble(j['amount']),
      periodEnd: jStr(j['periodEnd']),
      salaryAmount: jDoubleOrNull(j['salaryAmount']),
      method: PayMethod.parse(j['method']),
      note: jStr(j['note']),
      status: PaymentStatus.parse(j['status']),
      requestedBy: PersonRef.fromJson(j['requestedBy']),
      requestedAt: jDate(j['requestedAt']),
      decidedBy: PersonRef.fromJson(j['decidedBy']),
      decidedAt: jDate(j['decidedAt']),
      decisionNote: jStr(j['decisionNote']),
      reference: jStr(j['reference']),
      paidOn: jStr(j['paidOn']),
      resultId: jStr(j['resultId']),
      selfApproved: jBool(j['selfApproved']),
      canDecide: jBool(j['canDecide']),
      settlementId: jStr(j['settlementId']),
    );
  }

  final String id;
  final PaymentKind kind;
  final PaymentSubject subject;
  final ZoneRef? zone;
  final double amount;
  final String? periodEnd;
  final double? salaryAmount;
  final PayMethod method;
  final String? note;
  final PaymentStatus status;
  final PersonRef? requestedBy;
  final DateTime? requestedAt;
  final PersonRef? decidedBy;
  final DateTime? decidedAt;
  final String? decisionNote;
  final String? reference;
  final String? paidOn;
  final String? resultId;

  /// An admin approved their own request under the one-admin switch (0152).
  final bool selfApproved;

  /// True when the viewer may approve: someone else's request, or — only for an
  /// admin while one-admin payments are on — their own.
  final bool canDecide;

  /// The draft a vendor-settlement request pays (Phase 6); null for riders.
  final String? settlementId;

  bool get pending => status == PaymentStatus.pendingApproval;
}

class PaymentCounts {
  const PaymentCounts({this.pendingApproval = 0, this.approved = 0, this.rejected = 0, this.cancelled = 0});
  factory PaymentCounts.fromJson(Map<String, dynamic>? j) => PaymentCounts(
        pendingApproval: jInt(j?['pending_approval']),
        approved: jInt(j?['approved']),
        rejected: jInt(j?['rejected']),
        cancelled: jInt(j?['cancelled']),
      );
  final int pendingApproval;
  final int approved;
  final int rejected;
  final int cancelled;
}

class PaymentRequestPage {
  const PaymentRequestPage({required this.items, this.nextCursor, this.counts = const PaymentCounts()});
  factory PaymentRequestPage.fromJson(Map<String, dynamic> j) => PaymentRequestPage(
        items: [for (final r in jMaps(j['items'])) PaymentRequest.fromJson(r)],
        nextCursor: jStr(j['nextCursor']),
        counts: PaymentCounts.fromJson(jMap(j['counts'])),
      );
  final List<PaymentRequest> items;
  final String? nextCursor;
  final PaymentCounts counts;
}

/// What the Approvals list asks for. [mine] = requests this manager made.
class PaymentRequestFilters {
  const PaymentRequestFilters({this.status, this.mine = false, this.zoneId, this.kind});
  final PaymentStatus? status;
  final bool mine;
  final String? zoneId;

  /// Filtered on the server, so a long list of one kind is never hidden
  /// behind a first page of the other.
  final PaymentKind? kind;

  Map<String, String> toQuery() => {
        if (status != null) 'status': status!.wire,
        if (mine) 'mine': '1',
        'zone': ?zoneId,
        if (kind != null && kind != PaymentKind.unknown) 'kind': kind!.wire,
      };

  @override
  bool operator ==(Object other) =>
      other is PaymentRequestFilters &&
      other.status == status &&
      other.mine == mine &&
      other.zoneId == zoneId &&
      other.kind == kind;

  @override
  int get hashCode => Object.hash(status, mine, zoneId, kind);
}

const _uuid = Uuid();

String _ymd(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// A new rider payout request (`POST /api/manager/payments/requests`).
class PayoutRequestDraft {
  PayoutRequestDraft({
    required this.riderId,
    required this.periodEnd,
    required this.method,
    this.salaryAmount,
    this.note,
    String? clientActionId,
  }) : clientActionId = clientActionId ?? _uuid.v4();

  final String riderId;
  final DateTime periodEnd;
  final PayMethod method;
  final double? salaryAmount;
  final String? note;
  final String clientActionId;

  Map<String, dynamic> toJson() => {
        'clientActionId': clientActionId,
        'kind': 'rider_payout',
        'riderId': riderId,
        'periodEnd': _ymd(periodEnd),
        'method': method.wire,
        'salaryAmount': salaryAmount,
        'note': (note?.trim().isEmpty ?? true) ? null : note!.trim(),
      };
}

enum PaymentDecisionKind { approve, reject, cancel }

/// Approve (reference + paid-on), reject (note) or withdraw one request.
/// The id is made once, so a retry — or a re-send after `amount_changed`
/// with [confirmAmount] — is the same decision to the server.
class PaymentDecision {
  PaymentDecision({
    required this.decision,
    this.reference,
    this.paidOn,
    this.confirmAmount,
    this.note,
    String? clientActionId,
  }) : clientActionId = clientActionId ?? _uuid.v4();

  final PaymentDecisionKind decision;
  final String? reference;
  final DateTime? paidOn;
  final double? confirmAmount;
  final String? note;
  final String clientActionId;

  PaymentDecision confirming(double amount) => PaymentDecision(
        decision: decision,
        reference: reference,
        paidOn: paidOn,
        confirmAmount: amount,
        note: note,
        clientActionId: clientActionId,
      );

  Map<String, dynamic> toJson() => {
        'clientActionId': clientActionId,
        'decision': decision.name,
        if (reference != null) 'reference': reference,
        if (paidOn != null) 'paidOn': _ymd(paidOn!),
        if (confirmAmount != null) 'confirmAmount': confirmAmount,
        if (note != null) 'note': note,
      };
}
