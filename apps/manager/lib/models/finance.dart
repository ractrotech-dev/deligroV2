import 'package:uuid/uuid.dart';

import 'json_util.dart';
import 'rider.dart' show Payout;
import 'vendors.dart' show PersonRef, ZoneRef;

/// Finance (§7) as `/api/manager/finance/*` sends it (Phase 6 plan, "API
/// contract"). Order and settlement money is whole rupees (`int`); rider
/// ledger money keeps its paise (`double`).

ZoneRef? _zone(Object? v) {
  final z = jRef(v);
  return z == null ? null : ZoneRef(id: z.id, name: z.name);
}

/// The period and zone a finance answer covers.
class FinanceFilters {
  const FinanceFilters({required this.from, required this.to, this.zone});
  factory FinanceFilters.fromJson(Map<String, dynamic>? j) =>
      FinanceFilters(from: jStrOr(j?['from']), to: jStrOr(j?['to']), zone: _zone(j?['zone']));
  final String from;
  final String to;

  /// Null = all my zones.
  final ZoneRef? zone;
}

/// What a finance screen asks for: an inclusive IST date range and a zone.
class FinanceQuery {
  const FinanceQuery({required this.from, required this.to, this.zoneId});
  final String from;
  final String to;
  final String? zoneId;

  Map<String, String> toQuery() => {'from': from, 'to': to, 'zone': ?zoneId};

  @override
  bool operator ==(Object other) =>
      other is FinanceQuery && other.from == from && other.to == to && other.zoneId == zoneId;

  @override
  int get hashCode => Object.hash(from, to, zoneId);
}

/// A count and the money it adds up to.
class CountAmount {
  const CountAmount({this.count = 0, this.amount = 0});
  factory CountAmount.fromJson(Map<String, dynamic>? j, {String amountKey = 'amount'}) =>
      CountAmount(count: jInt(j?['count']), amount: (j?[amountKey] as num?) ?? 0);
  final int count;
  final num amount;
}

class Discounts {
  const Discounts({this.vendor = 0, this.platform = 0, this.total = 0});
  factory Discounts.fromJson(Map<String, dynamic>? j) =>
      Discounts(vendor: jInt(j?['vendor']), platform: jInt(j?['platform']), total: jInt(j?['total']));
  final int vendor;

  /// Deligro-funded.
  final int platform;
  final int total;
}

class PlatformCommission {
  const PlatformCommission({this.commission = 0, this.commissionGst = 0, this.otherCharges = 0, this.total = 0});
  factory PlatformCommission.fromJson(Map<String, dynamic>? j) => PlatformCommission(
        commission: jInt(j?['commission']),
        commissionGst: jInt(j?['commissionGst']),
        otherCharges: jInt(j?['otherCharges']),
        total: jInt(j?['total']),
      );
  final int commission;
  final int commissionGst;
  final int otherCharges;
  final int total;
}

/// §7 "Sales and commission" — the nine figures.
class FinanceSales {
  const FinanceSales({
    this.grossSales = 0,
    this.customerPaid = 0,
    this.netSales = 0,
    this.discounts = const Discounts(),
    this.refunds = const CountAmount(),
    this.refundsOnCancelled = 0,
    this.correctionsOutstanding = const CountAmount(),
    this.correctionsApplied = const CountAmount(),
    this.commission = const PlatformCommission(),
    this.deliveryFees = 0,
    this.riderEarnings = 0,
    this.vendorPayable = 0,
    this.vendorRecoverable = 0,
    this.riderPayable = 0,
    this.cancelled = const CountAmount(),
  });

  factory FinanceSales.fromJson(Map<String, dynamic>? j) {
    final adj = jMap(j?['adjustments']);
    return FinanceSales(
      grossSales: jInt(j?['grossSales']),
      customerPaid: jInt(j?['customerPaid']),
      netSales: jInt(j?['netSales']),
      discounts: Discounts.fromJson(jMap(j?['discounts'])),
      refunds: CountAmount.fromJson(jMap(j?['refunds']), amountKey: 'total'),
      refundsOnCancelled: jInt(jMap(j?['refunds'])?['onCancelled']),
      correctionsOutstanding: CountAmount.fromJson(jMap(adj?['correctionsOutstanding'])),
      correctionsApplied: CountAmount.fromJson(jMap(adj?['correctionsApplied'])),
      commission: PlatformCommission.fromJson(jMap(j?['platformCommission'])),
      deliveryFees: jInt(j?['deliveryFees']),
      riderEarnings: jDouble(j?['riderEarnings']),
      vendorPayable: jInt(j?['vendorPayable']),
      vendorRecoverable: jInt(j?['vendorRecoverable']),
      riderPayable: jDouble(j?['riderPayable']),
      cancelled: CountAmount.fromJson(jMap(j?['cancelled']), amountKey: 'value'),
    );
  }

  final int grossSales;
  final int customerPaid;
  final int netSales;
  final Discounts discounts;
  final CountAmount refunds;

  /// Approved refunds on orders later cancelled: in the refunds report, never off net sales.
  final int refundsOnCancelled;
  final CountAmount correctionsOutstanding;
  final CountAmount correctionsApplied;
  final PlatformCommission commission;
  final int deliveryFees;
  final double riderEarnings;
  final int vendorPayable;
  final int vendorRecoverable;
  final double riderPayable;

  /// Kept apart from net sales (§13).
  final CountAmount cancelled;
}

/// §7 "Payment tracking" — dues, completed payments, issues, approvals.
class FinancePayments {
  const FinancePayments({
    this.vendorDue = 0,
    this.vendorPaid = const CountAmount(),
    this.riderDue = 0,
    this.riderPaid = const CountAmount(),
    this.issuesWarning = 0,
    this.issuesCritical = 0,
    this.pendingApprovals = 0,
  });

  factory FinancePayments.fromJson(Map<String, dynamic>? j) {
    final issues = jMap(j?['issues']);
    return FinancePayments(
      vendorDue: jInt(j?['vendorDue']),
      vendorPaid: CountAmount.fromJson(jMap(j?['vendorPaid'])),
      riderDue: jDouble(j?['riderDue']),
      riderPaid: CountAmount.fromJson(jMap(j?['riderPaid'])),
      issuesWarning: jInt(issues?['warning']),
      issuesCritical: jInt(issues?['critical']),
      pendingApprovals: jInt(j?['pendingApprovals']),
    );
  }

  final int vendorDue;
  final CountAmount vendorPaid;
  final double riderDue;
  final CountAmount riderPaid;
  final int issuesWarning;
  final int issuesCritical;
  final int pendingApprovals;

  int get issues => issuesWarning + issuesCritical;
}

class FinanceDay {
  const FinanceDay({
    required this.date,
    this.customerPaid = 0,
    this.netSales = 0,
    this.commission = 0,
    this.deliveryFees = 0,
    this.refunds = 0,
  });
  factory FinanceDay.fromJson(Map<String, dynamic> j) => FinanceDay(
        date: jStrOr(j['date']),
        customerPaid: jInt(j['customerPaid']),
        netSales: jInt(j['netSales']),
        commission: jInt(j['commission']),
        deliveryFees: jInt(j['deliveryFees']),
        refunds: jInt(j['refunds']),
      );
  final String date;
  final int customerPaid;
  final int netSales;
  final int commission;
  final int deliveryFees;
  final int refunds;
}

class FinanceOverview {
  const FinanceOverview({
    required this.filters,
    required this.sales,
    required this.payments,
    this.series = const [],
    this.generatedAt,
  });

  factory FinanceOverview.fromJson(Map<String, dynamic> j) => FinanceOverview(
        filters: FinanceFilters.fromJson(jMap(j['filters'])),
        generatedAt: jDate(j['generatedAt']),
        sales: FinanceSales.fromJson(jMap(j['sales'])),
        payments: FinancePayments.fromJson(jMap(j['payments'])),
        series: [for (final d in jMaps(j['series'])) FinanceDay.fromJson(d)],
      );

  final FinanceFilters filters;
  final DateTime? generatedAt;
  final FinanceSales sales;
  final FinancePayments payments;
  final List<FinanceDay> series;
}

// ── Dues ─────────────────────────────────────────────────────────────────────

class VendorDue {
  const VendorDue({
    required this.vendor,
    this.zone,
    this.cycle = 'weekly',
    this.unsettledOrders = 0,
    this.oldestUnsettledAt,
    this.payable = 0,
    this.recoverable = 0,
    this.outstandingCorrections = 0,
    this.lastPaidAt,
    this.delayed = false,
    this.pendingRequestId,
  });

  factory VendorDue.fromJson(Map<String, dynamic> j) => VendorDue(
        vendor: PersonRef.fromJson(j['vendor']) ?? const PersonRef(id: '', name: ''),
        zone: _zone(j['zone']),
        cycle: jStrOr(j['cycle'], 'weekly'),
        unsettledOrders: jInt(j['unsettledOrders']),
        oldestUnsettledAt: jDate(j['oldestUnsettledAt']),
        payable: jInt(j['payable']),
        recoverable: jInt(j['recoverable']),
        outstandingCorrections: jInt(j['outstandingCorrections']),
        lastPaidAt: jDate(j['lastPaidAt']),
        delayed: jBool(j['delayed']),
        pendingRequestId: jStr(j['pendingRequestId']),
      );

  /// The shop (id + name).
  final PersonRef vendor;
  final ZoneRef? zone;

  /// `weekly` or `monthly`.
  final String cycle;
  final int unsettledOrders;
  final DateTime? oldestUnsettledAt;
  final int payable;

  /// What the shop owes Deligro (cash-order commission not yet recovered).
  final int recoverable;
  final int outstandingCorrections;
  final DateTime? lastPaidAt;
  final bool delayed;

  /// A settlement already waiting for approval.
  final String? pendingRequestId;
}

class RiderRefCode {
  const RiderRefCode({required this.id, required this.name, this.code});
  factory RiderRefCode.fromJson(Map<String, dynamic>? j) =>
      RiderRefCode(id: jStrOr(j?['id']), name: jStrOr(j?['name']), code: jStr(j?['code']));
  final String id;
  final String name;
  final String? code;

  String get label => [name, ?code].join(' · ');
}

class LastPayout {
  const LastPayout({required this.amount, this.paidOn, this.reference});
  static LastPayout? fromJson(Object? v) {
    final j = jMap(v);
    if (j == null) return null;
    return LastPayout(amount: jDouble(j['amount']), paidOn: jStr(j['paidOn']), reference: jStr(j['reference']));
  }

  final double amount;
  final String? paidOn;
  final String? reference;
}

class RiderDue {
  const RiderDue({
    required this.rider,
    this.unpaid = 0,
    this.oldestUnpaidOn,
    this.lastPayout,
    this.delayed = false,
    this.pendingRequestId,
  });

  factory RiderDue.fromJson(Map<String, dynamic> j) => RiderDue(
        rider: RiderRefCode.fromJson(jMap(j['rider'])),
        unpaid: jDouble(j['unpaid']),
        oldestUnpaidOn: jStr(j['oldestUnpaidOn']),
        lastPayout: LastPayout.fromJson(j['lastPayout']),
        delayed: jBool(j['delayed']),
        pendingRequestId: jStr(j['pendingRequestId']),
      );

  final RiderRefCode rider;
  final double unpaid;
  final String? oldestUnpaidOn;
  final LastPayout? lastPayout;
  final bool delayed;
  final String? pendingRequestId;
}

class VendorDuesPage {
  const VendorDuesPage({required this.items, this.nextCursor, this.totalPayable = 0, this.count = 0});
  factory VendorDuesPage.fromJson(Map<String, dynamic> j) {
    final t = jMap(j['totals']);
    return VendorDuesPage(
      items: [for (final r in jMaps(j['items'])) VendorDue.fromJson(r)],
      nextCursor: jStr(j['nextCursor']),
      totalPayable: jInt(t?['payable']),
      count: jInt(t?['count']),
    );
  }
  final List<VendorDue> items;
  final String? nextCursor;
  final int totalPayable;
  final int count;
}

class RiderDuesPage {
  const RiderDuesPage({required this.items, this.nextCursor, this.totalPayable = 0, this.count = 0});
  factory RiderDuesPage.fromJson(Map<String, dynamic> j) {
    final t = jMap(j['totals']);
    return RiderDuesPage(
      items: [for (final r in jMaps(j['items'])) RiderDue.fromJson(r)],
      nextCursor: jStr(j['nextCursor']),
      totalPayable: jDouble(t?['payable']),
      count: jInt(t?['count']),
    );
  }
  final List<RiderDue> items;
  final String? nextCursor;
  final double totalPayable;
  final int count;
}

/// The totals a dues list sends with every page.
class DueTotals {
  const DueTotals({this.payable = 0, this.count = 0});
  final num payable;
  final int count;
}

// ── Failed or delayed transactions ───────────────────────────────────────────

enum FinanceIssueType {
  failedPayment('failed_payment', 'Online payments failed'),
  stuckPayment('stuck_payment', 'Payments stuck'),
  refundUnsent('refund_unsent', 'Refunds not sent'),
  settlementDelayed('settlement_delayed', 'Vendor settlements overdue'),
  draftStale('draft_stale', 'Draft settlements untouched'),
  approvalOverdue('approval_overdue', 'Approvals waiting too long'),
  riderPayoutDelayed('rider_payout_delayed', 'Rider payouts delayed'),
  unknown('unknown', 'Other');

  const FinanceIssueType(this.wire, this.label);
  final String wire;
  final String label;

  static FinanceIssueType parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);

  static const known = [
    failedPayment,
    stuckPayment,
    refundUnsent,
    settlementDelayed,
    draftStale,
    approvalOverdue,
    riderPayoutDelayed,
  ];
}

enum IssueSeverity {
  warning,
  critical;

  static IssueSeverity parse(Object? s) => s == 'critical' ? critical : warning;
}

enum IssueSubjectKind {
  order,
  vendor,
  settlement,
  refund,
  paymentRequest,
  rider,
  unknown;

  static IssueSubjectKind parse(Object? s) =>
      s == 'payment_request' ? paymentRequest : jEnum(values, s, unknown);
}

class IssueSubject {
  const IssueSubject({required this.kind, required this.id, required this.label});
  factory IssueSubject.fromJson(Map<String, dynamic>? j) => IssueSubject(
        kind: IssueSubjectKind.parse(j?['kind']),
        id: jStrOr(j?['id']),
        label: jStrOr(j?['label']),
      );
  final IssueSubjectKind kind;
  final String id;
  final String label;
}

class FinanceIssue {
  const FinanceIssue({
    required this.type,
    required this.severity,
    required this.title,
    required this.subject,
    this.detail,
    this.amount,
    this.since,
    this.reference,
  });

  factory FinanceIssue.fromJson(Map<String, dynamic> j) => FinanceIssue(
        type: FinanceIssueType.parse(j['type']),
        severity: IssueSeverity.parse(j['severity']),
        title: jStrOr(j['title']),
        detail: jStr(j['detail']),
        amount: j['amount'] is num ? j['amount'] as num : null,
        since: jDate(j['since']),
        subject: IssueSubject.fromJson(jMap(j['subject'])),
        reference: jStr(j['reference']),
      );

  final FinanceIssueType type;
  final IssueSeverity severity;
  final String title;
  final String? detail;

  /// Rupees; paise for rider items.
  final num? amount;
  final DateTime? since;
  final IssueSubject subject;
  final String? reference;
}

class FinanceIssuePage {
  const FinanceIssuePage({required this.items, this.nextCursor, this.counts = const {}});
  factory FinanceIssuePage.fromJson(Map<String, dynamic> j) {
    final c = jMap(j['counts']) ?? const {};
    return FinanceIssuePage(
      items: [for (final r in jMaps(j['items'])) FinanceIssue.fromJson(r)],
      nextCursor: jStr(j['nextCursor']),
      counts: {for (final t in FinanceIssueType.known) t: jInt(c[t.wire])},
    );
  }
  final List<FinanceIssue> items;
  final String? nextCursor;
  final Map<FinanceIssueType, int> counts;
}

// ── Rider payouts ────────────────────────────────────────────────────────────

class RiderPayoutItem {
  const RiderPayoutItem({required this.payout, required this.rider});
  factory RiderPayoutItem.fromJson(Map<String, dynamic> j) =>
      RiderPayoutItem(payout: Payout.fromJson(j), rider: RiderRefCode.fromJson(jMap(j['rider'])));
  final Payout payout;
  final RiderRefCode rider;
}

class RiderPayoutPage {
  const RiderPayoutPage({required this.items, this.nextCursor, this.totalAmount = 0, this.count = 0});
  factory RiderPayoutPage.fromJson(Map<String, dynamic> j) {
    final t = jMap(j['totals']);
    return RiderPayoutPage(
      items: [for (final r in jMaps(j['items'])) RiderPayoutItem.fromJson(r)],
      nextCursor: jStr(j['nextCursor']),
      totalAmount: jDouble(t?['amount']),
      count: jInt(t?['count']),
    );
  }
  final List<RiderPayoutItem> items;
  final String? nextCursor;
  final double totalAmount;
  final int count;
}

// ── Refunds ──────────────────────────────────────────────────────────────────

enum RefundStatus {
  pending('pending', 'Waiting'),
  approved('approved', 'Approved'),
  denied('denied', 'Denied'),
  unknown('unknown', 'Unknown');

  const RefundStatus(this.wire, this.label);
  final String wire;
  final String label;

  static RefundStatus parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

enum RefundOrigin {
  customer('customer', 'Customer asked'),
  vendorRejected('vendor_rejected', 'Shop rejected the order'),
  admin('admin', 'Deligro'),
  system('system', 'System'),
  unknown('unknown', 'Other');

  const RefundOrigin(this.wire, this.label);
  final String wire;
  final String label;

  static RefundOrigin parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

class RefundOrder {
  const RefundOrder({required this.id, required this.code, this.total = 0, this.paymentMethod, this.placedAt});
  factory RefundOrder.fromJson(Map<String, dynamic>? j) => RefundOrder(
        id: jStrOr(j?['id']),
        code: jStrOr(j?['code']),
        total: jInt(j?['total']),
        paymentMethod: jStr(j?['paymentMethod']),
        placedAt: jDate(j?['placedAt']),
      );
  final String id;
  final String code;
  final int total;
  final String? paymentMethod;
  final DateTime? placedAt;
}

class RefundItem {
  const RefundItem({
    required this.id,
    required this.order,
    required this.amount,
    required this.status,
    required this.origin,
    this.vendor,
    this.reason,
    this.requestedAt,
    this.decidedBy,
    this.providerRefundId,
    this.settlementEffect,
  });

  factory RefundItem.fromJson(Map<String, dynamic> j) => RefundItem(
        id: jStrOr(j['id']),
        order: RefundOrder.fromJson(jMap(j['order'])),
        vendor: PersonRef.fromJson(j['vendor']),
        amount: jInt(j['amount']),
        reason: jStr(j['reason']),
        origin: RefundOrigin.parse(j['origin']),
        status: RefundStatus.parse(j['status']),
        requestedAt: jDate(j['requestedAt']),
        decidedBy: PersonRef.fromJson(j['decidedBy']),
        providerRefundId: jStr(j['providerRefundId']),
        settlementEffect: jStr(j['settlementEffect']),
      );

  final String id;
  final RefundOrder order;
  final PersonRef? vendor;
  final int amount;
  final String? reason;
  final RefundOrigin origin;
  final RefundStatus status;
  final DateTime? requestedAt;
  final PersonRef? decidedBy;
  final String? providerRefundId;

  /// `none`, `draft_flagged`, `correction_created`, or null.
  final String? settlementEffect;
}

class RefundPage {
  const RefundPage({required this.items, this.nextCursor, this.pendingCount = 0});
  factory RefundPage.fromJson(Map<String, dynamic> j) => RefundPage(
        items: [for (final r in jMaps(j['items'])) RefundItem.fromJson(r)],
        nextCursor: jStr(j['nextCursor']),
        pendingCount: jInt(jMap(j['counts'])?['pending']),
      );
  final List<RefundItem> items;
  final String? nextCursor;
  final int pendingCount;
}

const _uuid = Uuid();

/// Approve or deny one refund. The id is made once, so a retry after
/// `effect_failed` (decision saved, finishing it failed) is the same decision.
class RefundDecision {
  RefundDecision({required this.approve, required this.reason, String? clientActionId})
      : clientActionId = clientActionId ?? _uuid.v4();
  final bool approve;
  final String reason;
  final String clientActionId;

  Map<String, dynamic> toJson() =>
      {'clientActionId': clientActionId, 'decision': approve ? 'approve' : 'deny', 'reason': reason.trim()};
}

/// The refund-decision failures [refundFailure] has its own words for.
const refundFailureCodes = {
  'effect_failed', 'recorded_failed_after_gateway', 'gateway_unknown', 'gateway_failed', 'in_progress', 'gateway_paid',
};

/// What to tell the manager when a refund decision fails, and whether Retry is
/// safe. The server claims each refund before calling Razorpay (0156), so a
/// retry after `effect_failed` records the decision without paying twice; the
/// cases where money may have moved without a record get no Retry at all.
({String message, bool retry}) refundFailure(String code) => switch (code) {
      'effect_failed' => (
          message: 'The money was refunded but the decision didn\'t save. Retry finishes it — it won\'t pay twice.',
          retry: true,
        ),
      'recorded_failed_after_gateway' => (
          message: "Money was sent but not recorded — don't retry. Tell an admin so it can be reconciled.",
          retry: false,
        ),
      'gateway_unknown' => (
          message: "Razorpay didn't answer, so we can't tell if the money went. Don't retry — an admin checks Razorpay first.",
          retry: false,
        ),
      'gateway_failed' => (message: 'Razorpay refused the refund. Nothing was returned; you can try again.', retry: true),
      'in_progress' => (
          message: 'This refund is being processed, or an earlier attempt is waiting for an admin to check Razorpay.',
          retry: false,
        ),
      'gateway_paid' => (message: 'Razorpay already returned this money. Approve it to record that.', retry: false),
      _ => (message: "That didn't go through. Try again.", retry: true),
    };

// ── Reconciliation ───────────────────────────────────────────────────────────

enum ReconSection {
  orders('orders', 'Orders'),
  online('online', 'Online payments'),
  cash('cash', 'Cash');

  const ReconSection(this.wire, this.label);
  final String wire;
  final String label;

  static ReconSection parse(Object? s) => jEnum(values, s, orders, (v) => v.wire);
}

class OrderRecon {
  const OrderRecon({
    required this.orderId,
    required this.orderCode,
    required this.state,
    this.vendor,
    this.deliveredAt,
    this.expected = 0,
    this.settled,
    this.difference = 0,
    this.settlementId,
    this.correctionId,
  });

  factory OrderRecon.fromJson(Map<String, dynamic> j) => OrderRecon(
        orderId: jStrOr(j['orderId']),
        orderCode: jStrOr(j['orderCode']),
        vendor: PersonRef.fromJson(j['vendor']),
        deliveredAt: jDate(j['deliveredAt']),
        state: jStrOr(j['state'], 'unknown'),
        expected: jInt(j['expected']),
        settled: jIntOrNull(j['settled']),
        difference: jInt(j['difference']),
        settlementId: jStr(j['settlementId']),
        correctionId: jStr(j['correctionId']),
      );

  final String orderId;
  final String orderCode;
  final PersonRef? vendor;
  final DateTime? deliveredAt;
  final String state;
  final int expected;

  /// Null when no settlement line exists yet.
  final int? settled;
  final int difference;
  final String? settlementId;
  final String? correctionId;
}

class OnlineRecon {
  const OnlineRecon({
    required this.orderId,
    required this.orderCode,
    required this.state,
    this.orderTotal = 0,
    this.paidAmount,
    this.paymentId,
  });
  factory OnlineRecon.fromJson(Map<String, dynamic> j) => OnlineRecon(
        orderId: jStrOr(j['orderId']),
        orderCode: jStrOr(j['orderCode']),
        orderTotal: jInt(j['orderTotal']),
        paidAmount: jIntOrNull(j['paidAmount']),
        paymentId: jStr(j['paymentId']),
        state: jStrOr(j['state'], 'unknown'),
      );
  final String orderId;
  final String orderCode;
  final int orderTotal;
  final int? paidAmount;
  final String? paymentId;
  final String state;
}

class CashRecon {
  const CashRecon({
    required this.day,
    required this.rider,
    required this.status,
    this.collected = 0,
    this.deposited = 0,
    this.pending = 0,
    this.depositIds = const [],
  });
  factory CashRecon.fromJson(Map<String, dynamic> j) => CashRecon(
        day: jStrOr(j['day']),
        rider: RiderRefCode.fromJson(jMap(j['rider'])),
        collected: jInt(j['collected']),
        deposited: jInt(j['deposited']),
        pending: jInt(j['pending']),
        status: jStrOr(j['status'], 'pending'),
        depositIds: jStrings(j['depositIds']),
      );
  final String day;
  final RiderRefCode rider;
  final int collected;
  final int deposited;
  final int pending;

  /// `settled`, `pending` or `disputed`.
  final String status;
  final List<String> depositIds;
}

class ManagerCashDay {
  const ManagerCashDay({required this.manager, required this.day, this.received = 0, this.handedOn = 0, this.pending = 0});
  factory ManagerCashDay.fromJson(Map<String, dynamic> j) => ManagerCashDay(
        manager: PersonRef.fromJson(j['manager']) ?? const PersonRef(id: '', name: ''),
        day: jStrOr(j['day']),
        received: jInt(j['received']),
        handedOn: jInt(j['handedOn']),
        pending: jInt(j['pending']),
      );
  final PersonRef manager;
  final String day;
  final int received;
  final int handedOn;
  final int pending;
}

class Reconciliation {
  const Reconciliation({
    required this.section,
    required this.filters,
    this.summary = const {},
    this.orderItems = const [],
    this.onlineItems = const [],
    this.cashItems = const [],
    this.managers = const [],
    this.nextCursor,
  });

  factory Reconciliation.fromJson(Map<String, dynamic> j) {
    final section = ReconSection.parse(j['section']);
    final items = jMaps(j['items']);
    return Reconciliation(
      section: section,
      filters: FinanceFilters.fromJson(jMap(j['filters'])),
      summary: {
        for (final e in (jMap(j['summary']) ?? const <String, dynamic>{}).entries)
          if (e.value is num) e.key: e.value as num,
      },
      orderItems: section == ReconSection.orders ? [for (final r in items) OrderRecon.fromJson(r)] : const [],
      onlineItems: section == ReconSection.online ? [for (final r in items) OnlineRecon.fromJson(r)] : const [],
      cashItems: section == ReconSection.cash ? [for (final r in items) CashRecon.fromJson(r)] : const [],
      managers: [for (final m in jMaps(j['managers'])) ManagerCashDay.fromJson(m)],
      nextCursor: jStr(j['nextCursor']),
    );
  }

  final ReconSection section;
  final FinanceFilters filters;

  /// Count (or rupees, for cash) per state, in the server's order.
  final Map<String, num> summary;
  final List<OrderRecon> orderItems;
  final List<OnlineRecon> onlineItems;
  final List<CashRecon> cashItems;
  final List<ManagerCashDay> managers;
  final String? nextCursor;

  int get itemCount => orderItems.length + onlineItems.length + cashItems.length;

  /// This page with [next] appended — every unmatched order can be listed, not
  /// just the first page. The summary stays this answer's (it already counts
  /// every row); a row already shown is not repeated.
  Reconciliation followedBy(Reconciliation next) {
    List<T> merge<T>(List<T> a, List<T> b, String Function(T) id) {
      final seen = {for (final x in a) id(x)};
      return [...a, for (final x in b) if (seen.add(id(x))) x];
    }

    return Reconciliation(
      section: section,
      filters: filters,
      summary: summary,
      orderItems: merge(orderItems, next.orderItems, (x) => x.orderId),
      onlineItems: merge(onlineItems, next.onlineItems, (x) => x.orderId),
      cashItems: merge(cashItems, next.cashItems, (x) => '${x.rider.id}|${x.day}'),
      managers: managers,
      nextCursor: next.nextCursor,
    );
  }
}
