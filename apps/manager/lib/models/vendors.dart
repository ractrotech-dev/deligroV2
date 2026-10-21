import 'package:uuid/uuid.dart';

import 'json_util.dart';
import 'tickets.dart';

/// Vendors as `/api/manager/vendors*` sends them (Phase 4 plan, "API
/// contract"). Enums parse leniently: an unknown value becomes `unknown`.

enum VendorStatus {
  pending('Pending'),
  active('Active'),
  inactive('Inactive'),
  suspended('Suspended'),
  rejected('Rejected'),
  unknown('Unknown');

  const VendorStatus(this.label);
  final String label;

  static VendorStatus parse(Object? s) => jEnum(values, s, unknown);
}

enum OpenState {
  open('open', 'Open now'),
  closed('closed', 'Closed'),
  temporarilyClosed('temporarily_closed', 'Temporarily closed'),
  holiday('holiday', 'On holiday'),
  weeklyOff('weekly_off', 'Weekly off'),
  outsideHours('outside_hours', 'Outside hours'),
  unknown('unknown', 'Unknown');

  const OpenState(this.wire, this.label);
  final String wire;
  final String label;

  static OpenState parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

enum DocType {
  fssai('fssai', 'FSSAI licence'),
  gst('gst', 'GST certificate'),
  pan('pan', 'PAN card'),
  bankProof('bank_proof', 'Bank proof'),
  shopLicense('shop_license', 'Shop licence'),
  other('other', 'Other document'),
  unknown('unknown', 'Document');

  const DocType(this.wire, this.label);
  final String wire;
  final String label;

  static DocType parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);

  /// The types a manager can upload (everything but `unknown`).
  static const uploadable = [fssai, gst, pan, bankProof, shopLicense, other];
}

enum DocStatus {
  pending('Waiting for review'),
  verified('Verified'),
  rejected('Rejected'),
  unknown('Unknown');

  const DocStatus(this.label);
  final String label;

  static DocStatus parse(Object? s) => jEnum(values, s, unknown);
}

class ZoneRef {
  const ZoneRef({required this.id, required this.name});
  final String id;
  final String name;
}

class VendorListItem {
  const VendorListItem({
    required this.id,
    required this.name,
    required this.slug,
    required this.status,
    required this.openState,
    this.category,
    this.zone,
    this.logoUrl,
    this.rating,
    this.ratingCount = 0,
    this.todayOrders = 0,
    this.pendingDocuments = 0,
    this.openComplaints = 0,
    this.createdAt,
  });

  factory VendorListItem.fromJson(Map<String, dynamic> j) {
    final z = jRef(j['zone']);
    return VendorListItem(
      id: jStrOr(j['id']),
      name: jStrOr(j['name']),
      slug: jStrOr(j['slug']),
      status: VendorStatus.parse(j['status']),
      openState: OpenState.parse(j['openState']),
      category: jStr(j['category']),
      zone: z == null ? null : ZoneRef(id: z.id, name: z.name),
      logoUrl: jStr(j['logoUrl']),
      rating: jDoubleOrNull(j['rating']),
      ratingCount: jInt(j['ratingCount']),
      todayOrders: jInt(j['todayOrders']),
      pendingDocuments: jInt(j['pendingDocuments']),
      // A count on list rows; on the detail it is the array of open tickets.
      openComplaints: j['openComplaints'] is List ? (j['openComplaints'] as List).length : jInt(j['openComplaints']),
      createdAt: jDate(j['createdAt']),
    );
  }

  final String id;
  final String name;
  final String slug;
  final VendorStatus status;
  final OpenState openState;
  final String? category;
  final ZoneRef? zone;
  final String? logoUrl;
  final double? rating;
  final int ratingCount;
  final int todayOrders;
  final int pendingDocuments;
  final int openComplaints;
  final DateTime? createdAt;
}

class VendorCounts {
  const VendorCounts({
    this.all = 0,
    this.pending = 0,
    this.active = 0,
    this.suspended = 0,
    this.rejected = 0,
    this.inactive = 0,
    this.online = 0,
  });

  factory VendorCounts.fromJson(Map<String, dynamic>? j) => j == null
      ? const VendorCounts()
      : VendorCounts(
          all: jInt(j['all']),
          pending: jInt(j['pending']),
          active: jInt(j['active']),
          suspended: jInt(j['suspended']),
          rejected: jInt(j['rejected']),
          inactive: jInt(j['inactive']),
          online: jInt(j['online']),
        );

  final int all;
  final int pending;
  final int active;
  final int suspended;
  final int rejected;
  final int inactive;
  final int online;

  int of(VendorStatus s) => switch (s) {
        VendorStatus.pending => pending,
        VendorStatus.active => active,
        VendorStatus.suspended => suspended,
        VendorStatus.rejected => rejected,
        VendorStatus.inactive => inactive,
        VendorStatus.unknown => 0,
      };
}

class VendorPage {
  const VendorPage({required this.items, this.nextCursor, this.counts = const VendorCounts()});
  factory VendorPage.fromJson(Map<String, dynamic> j) => VendorPage(
        items: [for (final v in jMaps(j['items'])) VendorListItem.fromJson(v)],
        nextCursor: jStr(j['nextCursor']),
        counts: VendorCounts.fromJson(jMap(j['counts'])),
      );
  final List<VendorListItem> items;
  final String? nextCursor;
  final VendorCounts counts;
}

class PersonRef {
  const PersonRef({required this.id, required this.name});
  static PersonRef? fromJson(Object? v) {
    final r = jRef(v);
    return r == null ? null : PersonRef(id: r.id, name: r.name);
  }

  final String id;
  final String name;
}

class VendorDocument {
  const VendorDocument({
    required this.id,
    required this.type,
    required this.fileName,
    required this.status,
    this.remarks,
    this.reviewedBy,
    this.reviewedAt,
    this.uploadedAt,
  });

  factory VendorDocument.fromJson(Map<String, dynamic> j) => VendorDocument(
        id: jStrOr(j['id']),
        type: DocType.parse(j['type']),
        fileName: jStrOr(j['fileName'], 'document'),
        status: DocStatus.parse(j['status']),
        remarks: jStr(j['remarks']),
        reviewedBy: PersonRef.fromJson(j['reviewedBy']),
        reviewedAt: jDate(j['reviewedAt']),
        uploadedAt: jDate(j['uploadedAt']),
      );

  final String id;
  final DocType type;
  final String fileName;
  final DocStatus status;
  final String? remarks;
  final PersonRef? reviewedBy;
  final DateTime? reviewedAt;
  final DateTime? uploadedAt;

  bool get isPdf => fileName.toLowerCase().endsWith('.pdf');
}

class SubRatings {
  const SubRatings({this.foodQuality, this.packaging, this.deliveryExperience, this.valueForMoney});
  factory SubRatings.fromJson(Map<String, dynamic>? j) => SubRatings(
        foodQuality: jIntOrNull(j?['foodQuality']),
        packaging: jIntOrNull(j?['packaging']),
        deliveryExperience: jIntOrNull(j?['deliveryExperience']),
        valueForMoney: jIntOrNull(j?['valueForMoney']),
      );
  final int? foodQuality;
  final int? packaging;
  final int? deliveryExperience;
  final int? valueForMoney;

  /// The ones given, labelled, in display order.
  List<(String, int)> get given => [
        if (foodQuality != null) ('Food', foodQuality!),
        if (packaging != null) ('Packaging', packaging!),
        if (deliveryExperience != null) ('Delivery', deliveryExperience!),
        if (valueForMoney != null) ('Value', valueForMoney!),
      ];
}

class ReviewItem {
  const ReviewItem({
    required this.id,
    required this.rating,
    this.comment,
    this.customerFirstName,
    this.createdAt,
    this.status = 'published',
    this.orderCode,
    this.subRatings = const SubRatings(),
    this.replyText,
    this.replyAt,
  });

  factory ReviewItem.fromJson(Map<String, dynamic> j) {
    final reply = jMap(j['reply']);
    return ReviewItem(
      id: jStrOr(j['id']),
      rating: jInt(j['rating']),
      comment: jStr(j['comment']),
      customerFirstName: jStr(j['customerFirstName']),
      createdAt: jDate(j['createdAt']),
      status: jStrOr(j['status'], 'published'),
      orderCode: jStr(j['orderCode']),
      subRatings: SubRatings.fromJson(jMap(j['subRatings'])),
      replyText: jStr(reply?['text']),
      replyAt: jDate(reply?['at']),
    );
  }

  final String id;
  final int rating;
  final String? comment;
  final String? customerFirstName;
  final DateTime? createdAt;
  final String status;
  final String? orderCode;
  final SubRatings subRatings;
  final String? replyText;
  final DateTime? replyAt;
}

class ReviewPage {
  const ReviewPage({required this.items, this.nextCursor});
  factory ReviewPage.fromJson(Map<String, dynamic> j) => ReviewPage(
        items: [for (final r in jMaps(j['items'])) ReviewItem.fromJson(r)],
        nextCursor: jStr(j['nextCursor']),
      );
  final List<ReviewItem> items;
  final String? nextCursor;
}

class VendorContact {
  const VendorContact({this.shopPhone, this.ownerName, this.ownerMobile, this.ownerEmail});
  factory VendorContact.fromJson(Map<String, dynamic>? j) => VendorContact(
        shopPhone: jStr(j?['shopPhone']),
        ownerName: jStr(j?['ownerName']),
        ownerMobile: jStr(j?['ownerMobile']),
        ownerEmail: jStr(j?['ownerEmail']),
      );
  final String? shopPhone;
  final String? ownerName;
  final String? ownerMobile;
  final String? ownerEmail;

  /// The number to call: the shop's, else the owner's.
  String? get callNumber => shopPhone ?? ownerMobile;
}

class VendorAddress {
  const VendorAddress({this.line, this.landmark, this.pincode, this.lat, this.lng});
  factory VendorAddress.fromJson(Map<String, dynamic>? j) => VendorAddress(
        line: jStr(j?['line']),
        landmark: jStr(j?['landmark']),
        pincode: jStr(j?['pincode']),
        lat: jDoubleOrNull(j?['lat']),
        lng: jDoubleOrNull(j?['lng']),
      );
  final String? line;
  final String? landmark;
  final String? pincode;
  final double? lat;
  final double? lng;

  bool get pinned => lat != null && lng != null;
}

class Holiday {
  const Holiday({required this.from, required this.to, this.note});
  final String from;
  final String to;
  final String? note;
}

class VendorHours {
  const VendorHours({
    this.opening,
    this.closing,
    this.weeklyOff = const [],
    this.closedUntil,
    this.holidays = const [],
    this.deliveryAvailable = true,
    this.selfPickup = false,
    this.prepMinutesDefault,
  });

  factory VendorHours.fromJson(Map<String, dynamic>? j) => VendorHours(
        opening: jStr(j?['opening']),
        closing: jStr(j?['closing']),
        weeklyOff: jStrings(j?['weeklyOff']),
        closedUntil: jDate(j?['closedUntil']),
        holidays: [
          for (final h in jMaps(j?['holidays']))
            Holiday(from: jStrOr(h['from']), to: jStrOr(h['to']), note: jStr(h['note'])),
        ],
        deliveryAvailable: j?['deliveryAvailable'] != false,
        selfPickup: jBool(j?['selfPickup']),
        prepMinutesDefault: jIntOrNull(j?['prepMinutesDefault']),
      );

  final String? opening;
  final String? closing;
  final List<String> weeklyOff;
  final DateTime? closedUntil;
  final List<Holiday> holidays;
  final bool deliveryAvailable;
  final bool selfPickup;
  final int? prepMinutesDefault;
}

class VendorRegistration {
  const VendorRegistration({this.fssaiNumber, this.tcAcceptedAt, this.tcVersion, this.onboardedAt});
  factory VendorRegistration.fromJson(Map<String, dynamic>? j) => VendorRegistration(
        fssaiNumber: jStr(j?['fssaiNumber']),
        tcAcceptedAt: jDate(j?['tcAcceptedAt']),
        tcVersion: jStr(j?['tcVersion']),
        onboardedAt: jDate(j?['onboardedAt']),
      );
  final String? fssaiNumber;
  final DateTime? tcAcceptedAt;
  final String? tcVersion;
  final DateTime? onboardedAt;
}

class VendorPerformance {
  const VendorPerformance({
    this.from = '',
    this.to = '',
    this.orders = 0,
    this.sales = 0,
    this.aov = 0,
    this.cancellationRate = 0,
    this.rejectionRate = 0,
    this.avgAcceptMinutes,
    this.avgPrepMinutes,
    this.rating,
    this.ratingCount = 0,
    this.ratingDistribution = const {},
  });

  factory VendorPerformance.fromJson(Map<String, dynamic>? j) {
    final dist = jMap(j?['ratingDistribution']) ?? const {};
    return VendorPerformance(
      from: jStrOr(j?['from']),
      to: jStrOr(j?['to']),
      orders: jInt(j?['orders']),
      sales: jInt(j?['sales']),
      aov: jInt(j?['aov']),
      cancellationRate: jDouble(j?['cancellationRate']),
      rejectionRate: jDouble(j?['rejectionRate']),
      avgAcceptMinutes: jDoubleOrNull(j?['avgAcceptMinutes']),
      avgPrepMinutes: jDoubleOrNull(j?['avgPrepMinutes']),
      rating: jDoubleOrNull(j?['rating']),
      ratingCount: jInt(j?['ratingCount']),
      ratingDistribution: {for (var s = 1; s <= 5; s++) s: jInt(dist['$s'])},
    );
  }

  final String from;
  final String to;
  final int orders;
  final int sales;
  final int aov;

  /// 0–1.
  final double cancellationRate;

  /// 0–1: cancelled by the vendor ÷ all orders.
  final double rejectionRate;
  final double? avgAcceptMinutes;
  final double? avgPrepMinutes;
  final double? rating;
  final int ratingCount;

  /// Stars (1–5) → count.
  final Map<int, int> ratingDistribution;
}

class SettlementRow {
  const SettlementRow({
    required this.id,
    this.periodStart,
    this.periodEnd,
    this.netPayable = 0,
    this.status = 'draft',
    this.paidAt,
    this.paymentRef,
  });

  factory SettlementRow.fromJson(Map<String, dynamic> j) => SettlementRow(
        id: jStrOr(j['id']),
        periodStart: jStr(j['periodStart']),
        periodEnd: jStr(j['periodEnd']),
        netPayable: jInt(j['netPayable']),
        status: jStrOr(j['status'], 'draft'),
        paidAt: jDate(j['paidAt']),
        paymentRef: jStr(j['paymentRef']),
      );

  final String id;
  final String? periodStart;
  final String? periodEnd;
  final int netPayable;
  final String status;
  final DateTime? paidAt;
  final String? paymentRef;
}

/// Present only when the manager has `manager.finance.view`.
class VendorFinance {
  const VendorFinance({
    this.commissionPct = 0,
    this.commissionGstPct = 0,
    this.otherChargesPerOrder = 0,
    this.settlementCycle,
    this.pendingPayment = 0,
    this.recoverable = 0,
    this.commissionThisPeriod = 0,
    this.settlements = const [],
  });

  factory VendorFinance.fromJson(Map<String, dynamic> j) => VendorFinance(
        commissionPct: jDouble(j['commissionPct']),
        commissionGstPct: jDouble(j['commissionGstPct']),
        otherChargesPerOrder: jInt(j['otherChargesPerOrder']),
        settlementCycle: jStr(j['settlementCycle']),
        pendingPayment: jInt(j['pendingPayment']),
        recoverable: jInt(j['recoverable']),
        commissionThisPeriod: jInt(j['commissionThisPeriod']),
        settlements: [for (final s in jMaps(j['settlements'])) SettlementRow.fromJson(s)],
      );

  final double commissionPct;
  final double commissionGstPct;
  final int otherChargesPerOrder;
  final String? settlementCycle;
  final int pendingPayment;
  final int recoverable;
  final int commissionThisPeriod;
  final List<SettlementRow> settlements;
}

class VendorAllowed {
  const VendorAllowed({
    this.approve = false,
    this.reject = false,
    this.suspend = false,
    this.reactivate = false,
    this.reviewDocuments = false,
    this.uploadDocuments = false,
  });

  factory VendorAllowed.fromJson(Map<String, dynamic>? j) => VendorAllowed(
        approve: jBool(j?['approve']),
        reject: jBool(j?['reject']),
        suspend: jBool(j?['suspend']),
        reactivate: jBool(j?['reactivate']),
        reviewDocuments: jBool(j?['reviewDocuments']),
        uploadDocuments: jBool(j?['uploadDocuments']),
      );

  final bool approve;
  final bool reject;
  final bool suspend;
  final bool reactivate;
  final bool reviewDocuments;
  final bool uploadDocuments;

  bool get anyStatus => approve || reject || suspend || reactivate;
}

class VendorDetail {
  const VendorDetail({
    required this.summary,
    this.statusReason,
    this.statusChangedAt,
    this.statusChangedBy,
    this.description,
    this.contact = const VendorContact(),
    this.address = const VendorAddress(),
    this.hours = const VendorHours(),
    this.registration = const VendorRegistration(),
    this.documents = const [],
    this.performance = const VendorPerformance(),
    this.finance,
    this.openComplaints = const [],
    this.allowed = const VendorAllowed(),
  });

  factory VendorDetail.fromJson(Map<String, dynamic> j) {
    final fin = jMap(j['finance']);
    return VendorDetail(
      summary: VendorListItem.fromJson(j),
      statusReason: jStr(j['statusReason']),
      statusChangedAt: jDate(j['statusChangedAt']),
      statusChangedBy: PersonRef.fromJson(j['statusChangedBy']),
      description: jStr(j['description']),
      contact: VendorContact.fromJson(jMap(j['contact'])),
      address: VendorAddress.fromJson(jMap(j['address'])),
      hours: VendorHours.fromJson(jMap(j['hours'])),
      registration: VendorRegistration.fromJson(jMap(j['registration'])),
      documents: [for (final d in jMaps(j['documents'])) VendorDocument.fromJson(d)],
      performance: VendorPerformance.fromJson(jMap(j['performance'])),
      finance: fin == null ? null : VendorFinance.fromJson(fin),
      openComplaints: [for (final t in jMaps(j['openComplaints'])) TicketSummary.fromJson(t)],
      allowed: VendorAllowed.fromJson(jMap(j['allowed'])),
    );
  }

  final VendorListItem summary;
  final String? statusReason;
  final DateTime? statusChangedAt;
  final PersonRef? statusChangedBy;
  final String? description;
  final VendorContact contact;
  final VendorAddress address;
  final VendorHours hours;
  final VendorRegistration registration;
  final List<VendorDocument> documents;
  final VendorPerformance performance;
  final VendorFinance? finance;
  final List<TicketSummary> openComplaints;
  final VendorAllowed allowed;

  String get id => summary.id;
  String get name => summary.name;
  VendorStatus get status => summary.status;
}

/// The list's quick filters (contract `filter=`).
enum VendorQuickFilter {
  active('active'),
  online('online'),
  pending('pending'),
  needsAttention('needs_attention');

  const VendorQuickFilter(this.wire);
  final String wire;

  static VendorQuickFilter? parse(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return null;
  }
}

/// What the Vendors list asks for. Immutable; a new value is a new list.
class VendorFilters {
  const VendorFilters({this.q, this.statuses = const {}, this.filter, this.zoneId, this.category});

  /// Reads `/more/vendors?…` — the dashboard's tiles send `filter=active` and
  /// `filter=online`.
  factory VendorFilters.fromUri(Uri uri) {
    final p = uri.queryParameters;
    String? s(String k) => (p[k]?.trim().isEmpty ?? true) ? null : p[k]!.trim();
    return VendorFilters(
      q: s('q'),
      statuses: {
        for (final w in (p['status'] ?? '').split(','))
          if (VendorStatus.parse(w.trim()) != VendorStatus.unknown) VendorStatus.parse(w.trim()),
      },
      filter: VendorQuickFilter.parse(s('filter')),
      zoneId: s('zone'),
      category: s('category'),
    );
  }

  final String? q;
  final Set<VendorStatus> statuses;
  final VendorQuickFilter? filter;
  final String? zoneId;
  final String? category;

  Map<String, String> toQuery() => {
        'q': ?q,
        if (statuses.isNotEmpty) 'status': (statuses.map((s) => s.name).toList()..sort()).join(','),
        'filter': ?filter?.wire,
        'zone': ?zoneId,
        'category': ?category,
      };

  bool get narrowed => q != null || statuses.isNotEmpty || filter != null || category != null;

  static const _unset = Object();

  VendorFilters copyWith({
    Object? q = _unset,
    Set<VendorStatus>? statuses,
    Object? filter = _unset,
    Object? zoneId = _unset,
    Object? category = _unset,
  }) =>
      VendorFilters(
        q: identical(q, _unset) ? this.q : q as String?,
        statuses: statuses ?? this.statuses,
        filter: identical(filter, _unset) ? this.filter : filter as VendorQuickFilter?,
        zoneId: identical(zoneId, _unset) ? this.zoneId : zoneId as String?,
        category: identical(category, _unset) ? this.category : category as String?,
      );

  @override
  bool operator ==(Object other) =>
      other is VendorFilters &&
      other.q == q &&
      other.filter == filter &&
      other.zoneId == zoneId &&
      other.category == category &&
      other.statuses.length == statuses.length &&
      other.statuses.containsAll(statuses);

  @override
  int get hashCode => Object.hash(q, filter, zoneId, category, Object.hashAllUnordered(statuses));
}

const _uuid = Uuid();

/// One audited decision about a vendor. The [clientActionId] is minted once
/// per intent and reused on retry (and on "Approve anyway"), so the server
/// applies it once.
sealed class VendorAction {
  VendorAction({required this.reason, String? clientActionId}) : clientActionId = clientActionId ?? _uuid.v4();
  final String reason;
  final String clientActionId;

  String get wire;

  Map<String, dynamic> toJson() => {'action': wire, 'reason': reason, 'clientActionId': clientActionId};
}

class ApproveVendor extends VendorAction {
  ApproveVendor({required this.expected, required super.reason, this.waiveDocuments = false, super.clientActionId});
  final VendorStatus expected;

  /// Sent as `override`: approve although required documents are unverified
  /// (recorded in the audit row).
  final bool waiveDocuments;

  @override
  String get wire => 'approve';

  /// The same decision, documents check waived ("Approve anyway").
  ApproveVendor anyway() =>
      ApproveVendor(expected: expected, reason: reason, waiveDocuments: true, clientActionId: clientActionId);

  @override
  Map<String, dynamic> toJson() => {...super.toJson(), 'expected': expected.name, 'override': waiveDocuments};
}

class RejectVendor extends VendorAction {
  RejectVendor({required this.expected, required super.reason, super.clientActionId});
  final VendorStatus expected;
  @override
  String get wire => 'reject';
  @override
  Map<String, dynamic> toJson() => {...super.toJson(), 'expected': expected.name};
}

class SuspendVendor extends VendorAction {
  SuspendVendor({required this.expected, required super.reason, super.clientActionId});
  final VendorStatus expected;
  @override
  String get wire => 'suspend';
  @override
  Map<String, dynamic> toJson() => {...super.toJson(), 'expected': expected.name};
}

class ReactivateVendor extends VendorAction {
  ReactivateVendor({required this.expected, required super.reason, super.clientActionId});
  final VendorStatus expected;
  @override
  String get wire => 'reactivate';
  @override
  Map<String, dynamic> toJson() => {...super.toJson(), 'expected': expected.name};
}

class VerifyDocument extends VendorAction {
  /// [note] is optional: only rejecting a document needs a reason.
  VerifyDocument({required this.documentId, String? note, super.clientActionId}) : super(reason: note?.trim() ?? '');
  final String documentId;
  String? get note => reason.isEmpty ? null : reason;
  @override
  String get wire => 'verify_document';
  @override
  Map<String, dynamic> toJson() => {
        'action': wire,
        'documentId': documentId,
        if (note != null) 'note': note,
        'clientActionId': clientActionId,
      };
}

class RejectDocument extends VendorAction {
  RejectDocument({required this.documentId, required super.reason, super.clientActionId});
  final String documentId;
  @override
  String get wire => 'reject_document';
  @override
  Map<String, dynamic> toJson() => {...super.toJson(), 'documentId': documentId};
}

/// The onboarding form, as `POST /api/manager/vendors` takes it.
class OnboardDraft {
  const OnboardDraft({
    this.zoneId,
    this.shopName = '',
    this.category,
    this.description,
    this.ownerName = '',
    this.mobile = '',
    this.altMobile,
    this.email = '',
    this.password,
    this.logoUrl,
    this.address = '',
    this.landmark,
    this.pincode,
    this.lat,
    this.lng,
    this.openingTime,
    this.closingTime,
    this.weeklyOff = const [],
    this.deliveryAvailable = true,
    this.selfPickup = false,
    this.fssaiNumber,
  });

  factory OnboardDraft.fromJson(Map<String, dynamic> j) => OnboardDraft(
        zoneId: jStr(j['zoneId']),
        shopName: jStrOr(j['shopName']),
        category: jStr(j['category']),
        description: jStr(j['description']),
        ownerName: jStrOr(j['ownerName']),
        mobile: jStrOr(j['mobile']),
        altMobile: jStr(j['altMobile']),
        email: jStrOr(j['email']),
        logoUrl: jStr(j['logoUrl']),
        address: jStrOr(j['address']),
        landmark: jStr(j['landmark']),
        pincode: jStr(j['pincode']),
        lat: jDoubleOrNull(j['lat']),
        lng: jDoubleOrNull(j['lng']),
        openingTime: jStr(j['openingTime']),
        closingTime: jStr(j['closingTime']),
        weeklyOff: jStrings(j['weeklyOff']),
        deliveryAvailable: j['deliveryAvailable'] != false,
        selfPickup: jBool(j['selfPickup']),
        fssaiNumber: jStr(j['fssaiNumber']),
      );

  final String? zoneId;
  final String shopName;
  final String? category;
  final String? description;
  final String ownerName;
  final String mobile;

  /// A second contact number (optional), as the registration wizard takes.
  final String? altMobile;
  final String email;

  /// Never saved with the draft on the device.
  final String? password;

  /// The shop logo, uploaded already (POST /api/manager/vendors/logo).
  final String? logoUrl;
  final String address;
  final String? landmark;
  final String? pincode;
  final double? lat;
  final double? lng;
  final String? openingTime;
  final String? closingTime;
  final List<String> weeklyOff;
  final bool deliveryAvailable;
  final bool selfPickup;
  final String? fssaiNumber;

  static final _mobile = RegExp(r'^[6-9]\d{9}$');
  static final _email = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');
  static final _pincode = RegExp(r'^\d{6}$');

  String? get shopError => zoneId == null
      ? 'Pick a zone'
      : shopName.trim().length < 2
          ? 'Enter the shop name'
          : null;

  String? get mobileError => _mobile.hasMatch(mobile.trim()) ? null : 'Enter a 10-digit mobile number';
  String? get emailError => _email.hasMatch(email.trim()) ? null : 'Enter a valid email';
  String? get passwordError => password == null || password!.isEmpty || password!.length >= 8 ? null : 'At least 8 characters';
  String? get altMobileError {
    final a = altMobile?.trim() ?? '';
    if (a.isEmpty) return null;
    if (!_mobile.hasMatch(a)) return 'Enter a 10-digit mobile number';
    if (a == mobile.trim()) return 'Use a different number from the main one';
    return null;
  }

  String? get ownerError =>
      ownerName.trim().length < 2 ? "Enter the owner's name" : mobileError ?? altMobileError ?? emailError ?? passwordError;

  String? get locationError => address.trim().length < 5
      ? 'Enter the shop address'
      : (pincode != null && pincode!.isNotEmpty && !_pincode.hasMatch(pincode!))
          ? 'Pincode is 6 digits'
          : null;

  String? get hoursError {
    final o = openingTime, c = closingTime;
    if ((o == null) != (c == null)) return 'Set both opening and closing time, or neither';
    return null;
  }

  OnboardDraft copyWith({
    Object? zoneId = _keep,
    String? shopName,
    Object? category = _keep,
    Object? description = _keep,
    String? ownerName,
    String? mobile,
    Object? altMobile = _keep,
    String? email,
    Object? password = _keep,
    Object? logoUrl = _keep,
    String? address,
    Object? landmark = _keep,
    Object? pincode = _keep,
    Object? lat = _keep,
    Object? lng = _keep,
    Object? openingTime = _keep,
    Object? closingTime = _keep,
    List<String>? weeklyOff,
    bool? deliveryAvailable,
    bool? selfPickup,
    Object? fssaiNumber = _keep,
  }) {
    T k<T>(Object? v, T old) => identical(v, _keep) ? old : v as T;
    return OnboardDraft(
      zoneId: k(zoneId, this.zoneId),
      shopName: shopName ?? this.shopName,
      category: k(category, this.category),
      description: k(description, this.description),
      ownerName: ownerName ?? this.ownerName,
      mobile: mobile ?? this.mobile,
      altMobile: k(altMobile, this.altMobile),
      email: email ?? this.email,
      password: k(password, this.password),
      logoUrl: k(logoUrl, this.logoUrl),
      address: address ?? this.address,
      landmark: k(landmark, this.landmark),
      pincode: k(pincode, this.pincode),
      lat: k(lat, this.lat),
      lng: k(lng, this.lng),
      openingTime: k(openingTime, this.openingTime),
      closingTime: k(closingTime, this.closingTime),
      weeklyOff: weeklyOff ?? this.weeklyOff,
      deliveryAvailable: deliveryAvailable ?? this.deliveryAvailable,
      selfPickup: selfPickup ?? this.selfPickup,
      fssaiNumber: k(fssaiNumber, this.fssaiNumber),
    );
  }

  static const _keep = Object();

  String? _blank(String? s) => s == null || s.trim().isEmpty ? null : s.trim();

  /// The request body (password only when typed).
  Map<String, dynamic> toRequest(String clientActionId) => {
        'clientActionId': clientActionId,
        'zoneId': zoneId,
        'shopName': shopName.trim(),
        'category': _blank(category),
        'description': _blank(description),
        'ownerName': ownerName.trim(),
        'mobile': mobile.trim(),
        'altMobile': _blank(altMobile),
        'email': email.trim(),
        'password': _blank(password),
        'logoUrl': logoUrl,
        'address': address.trim(),
        'landmark': _blank(landmark),
        'pincode': _blank(pincode),
        'lat': lat,
        'lng': lng,
        'openingTime': openingTime,
        'closingTime': closingTime,
        'weeklyOff': weeklyOff,
        'deliveryAvailable': deliveryAvailable,
        'selfPickup': selfPickup,
        'fssaiNumber': _blank(fssaiNumber),
      };

  /// What is kept on the device between sessions: everything but the password.
  Map<String, dynamic> toSaved() => {...toRequest('')..remove('clientActionId'), 'password': null};
}

/// `201` from onboarding.
class OnboardResult {
  const OnboardResult({required this.id, required this.slug, this.email, this.password});
  factory OnboardResult.fromJson(Map<String, dynamic> j) {
    final cred = jMap(j['credentials']);
    return OnboardResult(
      id: jStrOr(j['id']),
      slug: jStrOr(j['slug']),
      email: jStr(cred?['email']),
      password: jStr(cred?['password']),
    );
  }

  final String id;
  final String slug;

  /// Present only when the server generated a password; shown once.
  final String? email;
  final String? password;

  bool get hasCredentials => password != null;
}
