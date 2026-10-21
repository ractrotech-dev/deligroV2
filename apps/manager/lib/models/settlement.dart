import 'package:uuid/uuid.dart';

import 'json_util.dart';
import 'payment_request.dart';
import 'rider.dart' show ymd;
import 'vendors.dart' show PersonRef, ZoneRef;

/// Vendor settlements as `/api/manager/finance/settlements*` send them
/// (Phase 6 plan). Money is whole rupees.

enum SettlementStatus {
  draft('draft', 'Draft'),
  paid('paid', 'Paid'),
  voided('void', 'Void'),
  unknown('unknown', 'Unknown');

  const SettlementStatus(this.wire, this.label);
  final String wire;
  final String label;

  static SettlementStatus parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

/// What the history list filters on. "Awaiting approval" is a draft with a
/// pending request (`status=pending_approval`).
enum SettlementFilter {
  all(null, 'All'),
  draft('draft', 'Draft'),
  awaiting('pending_approval', 'Awaiting approval'),
  paid('paid', 'Paid'),
  voided('void', 'Void');

  const SettlementFilter(this.wire, this.label);
  final String? wire;
  final String label;
}

enum SettlementKind {
  batch,
  instant;

  static SettlementKind parse(Object? s) => s == 'instant' ? instant : batch;
}

class RequestRef {
  const RequestRef({required this.id, required this.status});
  static RequestRef? fromJson(Object? v) {
    final j = jMap(v);
    if (j == null) return null;
    return RequestRef(id: jStrOr(j['id']), status: PaymentStatus.parse(j['status']));
  }

  final String id;
  final PaymentStatus status;
}

class SettlementSummary {
  const SettlementSummary({
    required this.id,
    required this.vendor,
    required this.status,
    this.zone,
    this.kind = SettlementKind.batch,
    this.periodStart,
    this.periodEnd,
    this.orders = 0,
    this.foodGross = 0,
    this.commission = 0,
    this.commissionGst = 0,
    this.otherCharges = 0,
    this.refundsRecovered = 0,
    this.netPayable = 0,
    this.paymentRef,
    this.paidAt,
    this.paidBy,
    this.createdAt,
    this.createdBy,
    this.request,
  });

  factory SettlementSummary.fromJson(Map<String, dynamic> j) {
    final z = jRef(j['zone']);
    return SettlementSummary(
      id: jStrOr(j['id']),
      vendor: PersonRef.fromJson(j['vendor']) ?? const PersonRef(id: '', name: ''),
      zone: z == null ? null : ZoneRef(id: z.id, name: z.name),
      kind: SettlementKind.parse(j['kind']),
      status: SettlementStatus.parse(j['status']),
      periodStart: jStr(j['periodStart']),
      periodEnd: jStr(j['periodEnd']),
      orders: jInt(j['orders']),
      foodGross: jInt(j['foodGross']),
      commission: jInt(j['commission']),
      commissionGst: jInt(j['commissionGst']),
      otherCharges: jInt(j['otherCharges']),
      refundsRecovered: jInt(j['refundsRecovered']),
      netPayable: jInt(j['netPayable']),
      paymentRef: jStr(j['paymentRef']),
      paidAt: jDate(j['paidAt']),
      paidBy: PersonRef.fromJson(j['paidBy']),
      createdAt: jDate(j['createdAt']),
      createdBy: PersonRef.fromJson(j['createdBy']),
      request: RequestRef.fromJson(j['request']),
    );
  }

  final String id;
  final PersonRef vendor;
  final ZoneRef? zone;
  final SettlementKind kind;
  final SettlementStatus status;
  final String? periodStart;
  final String? periodEnd;
  final int orders;
  final int foodGross;
  final int commission;
  final int commissionGst;
  final int otherCharges;
  final int refundsRecovered;
  final int netPayable;

  /// The bank / UPI transaction reference (§7.7).
  final String? paymentRef;
  final DateTime? paidAt;
  final PersonRef? paidBy;
  final DateTime? createdAt;
  final PersonRef? createdBy;
  final RequestRef? request;

  bool get awaitingApproval => status == SettlementStatus.draft && request?.status == PaymentStatus.pendingApproval;

  /// "Awaiting approval" for a draft with a pending request, else the status.
  String get statusLabel => awaitingApproval ? 'Awaiting approval' : status.label;
}

class SettlementLine {
  const SettlementLine({
    required this.orderId,
    required this.orderCode,
    this.placedAt,
    this.paymentMethod,
    this.orderTotal = 0,
    this.deliveryFee = 0,
    this.foodGross = 0,
    this.commission = 0,
    this.commissionGst = 0,
    this.otherCharges = 0,
    this.refundRecovered = 0,
    this.vendorNet = 0,
    this.contribution = 0,
  });

  factory SettlementLine.fromJson(Map<String, dynamic> j) => SettlementLine(
        orderId: jStrOr(j['orderId']),
        orderCode: jStrOr(j['orderCode']),
        placedAt: jDate(j['placedAt']),
        paymentMethod: jStr(j['paymentMethod']),
        orderTotal: jInt(j['orderTotal']),
        deliveryFee: jInt(j['deliveryFee']),
        foodGross: jInt(j['foodGross']),
        commission: jInt(j['commission']),
        commissionGst: jInt(j['commissionGst']),
        otherCharges: jInt(j['otherCharges']),
        refundRecovered: jInt(j['refundRecovered']),
        vendorNet: jInt(j['vendorNet']),
        contribution: jInt(j['contribution']),
      );

  final String orderId;
  final String orderCode;
  final DateTime? placedAt;
  final String? paymentMethod;
  final int orderTotal;
  final int deliveryFee;
  final int foodGross;
  final int commission;
  final int commissionGst;
  final int otherCharges;
  final int refundRecovered;
  final int vendorNet;

  /// What this line adds to the payout (negative for a cash order: the shop
  /// already holds the money and the deductions are recovered).
  final int contribution;
}

enum CorrectionStatus {
  outstanding,
  applied,
  voided,
  unknown;

  static CorrectionStatus parse(Object? s) => s == 'void' || s == 'voided' ? voided : jEnum(values, s, unknown);
}

class SettlementCorrection {
  const SettlementCorrection({
    required this.id,
    required this.orderCode,
    required this.amount,
    required this.status,
    this.reason,
    this.originalSettlementId,
    this.appliedSettlementId,
    this.createdAt,
  });

  factory SettlementCorrection.fromJson(Map<String, dynamic> j) => SettlementCorrection(
        id: jStrOr(j['id']),
        orderCode: jStrOr(j['orderCode']),
        amount: jInt(j['amount']),
        reason: jStr(j['reason']),
        status: CorrectionStatus.parse(j['status']),
        originalSettlementId: jStr(j['originalSettlementId']),
        appliedSettlementId: jStr(j['appliedSettlementId']),
        createdAt: jDate(j['createdAt']),
      );

  final String id;
  final String orderCode;
  final int amount;
  final String? reason;
  final CorrectionStatus status;
  final String? originalSettlementId;
  final String? appliedSettlementId;
  final DateTime? createdAt;
}

class SettlementDetail {
  const SettlementDetail({
    required this.settlement,
    this.lines = const [],
    this.corrections = const [],
    this.request,
    this.stale = false,
    this.freshNetPayable,
  });

  factory SettlementDetail.fromJson(Map<String, dynamic> j) {
    final checks = jMap(j['checks']);
    final req = jMap(j['request']);
    return SettlementDetail(
      settlement: SettlementSummary.fromJson(jMap(j['settlement']) ?? const {}),
      lines: [for (final l in jMaps(j['lines'])) SettlementLine.fromJson(l)],
      corrections: [for (final c in jMaps(j['corrections'])) SettlementCorrection.fromJson(c)],
      request: req == null ? null : PaymentRequest.fromJson(req),
      stale: jBool(checks?['stale']),
      freshNetPayable: jIntOrNull(checks?['freshNetPayable']),
    );
  }

  final SettlementSummary settlement;
  final List<SettlementLine> lines;
  final List<SettlementCorrection> corrections;
  final PaymentRequest? request;

  /// A refund landed since the draft was built; approval will rebuild it.
  final bool stale;
  final int? freshNetPayable;
}

class SettlementPage {
  const SettlementPage({required this.items, this.nextCursor, this.totalNetPayable = 0, this.count = 0});
  factory SettlementPage.fromJson(Map<String, dynamic> j) {
    final t = jMap(j['totals']);
    return SettlementPage(
      items: [for (final s in jMaps(j['items'])) SettlementSummary.fromJson(s)],
      nextCursor: jStr(j['nextCursor']),
      totalNetPayable: jInt(t?['netPayable']),
      count: jInt(t?['count']),
    );
  }
  final List<SettlementSummary> items;
  final String? nextCursor;
  final int totalNetPayable;
  final int count;
}

/// What the history list asks for.
class SettlementFilters {
  const SettlementFilters({this.status = SettlementFilter.all, this.vendorId, this.from, this.to, this.zoneId});
  final SettlementFilter status;
  final String? vendorId;
  final String? from;
  final String? to;
  final String? zoneId;

  SettlementFilters copyWith({SettlementFilter? status, Object? vendorId = _keep, String? zoneId}) => SettlementFilters(
        status: status ?? this.status,
        vendorId: identical(vendorId, _keep) ? this.vendorId : vendorId as String?,
        from: from,
        to: to,
        zoneId: zoneId ?? this.zoneId,
      );

  Map<String, String> toQuery() => {
        'status': ?status.wire,
        'vendor': ?vendorId,
        'from': ?from,
        'to': ?to,
        'zone': ?zoneId,
      };

  @override
  bool operator ==(Object other) =>
      other is SettlementFilters &&
      other.status == status &&
      other.vendorId == vendorId &&
      other.from == from &&
      other.to == to &&
      other.zoneId == zoneId;

  @override
  int get hashCode => Object.hash(status, vendorId, from, to, zoneId);
}

const _keep = Object();
const _uuid = Uuid();

/// `POST /api/manager/finance/settlements` — put a shop up for payment, for a
/// period or one order. Exactly one of the two is sent.
class SettlementInitiation {
  SettlementInitiation({
    required this.vendorId,
    required this.method,
    this.from,
    this.to,
    this.orderId,
    this.note,
    String? clientActionId,
  }) : clientActionId = clientActionId ?? _uuid.v4();

  final String vendorId;
  final DateTime? from;
  final DateTime? to;
  final String? orderId;
  final PayMethod method;
  final String? note;
  final String clientActionId;

  Map<String, dynamic> toJson() => {
        'clientActionId': clientActionId,
        'vendorId': vendorId,
        if (orderId == null) 'from': from == null ? null : ymd(from!),
        if (orderId == null) 'to': to == null ? null : ymd(to!),
        'orderId': orderId,
        'method': method.wire,
        'note': (note?.trim().isEmpty ?? true) ? null : note!.trim(),
      };
}

/// The 201 answer to an initiation.
class SettlementInitiated {
  const SettlementInitiated({required this.settlement, required this.request});
  factory SettlementInitiated.fromJson(Map<String, dynamic> j) => SettlementInitiated(
        settlement: SettlementSummary.fromJson(jMap(j['settlement']) ?? const {}),
        request: PaymentRequest.fromJson(jMap(j['request']) ?? const {}),
      );
  final SettlementSummary settlement;
  final PaymentRequest request;
}
