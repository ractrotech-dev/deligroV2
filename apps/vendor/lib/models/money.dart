/// `/api/vendor/payments`, `/payments/settlements/:id`, `/reports` and
/// `/invoice-profile` (src/lib/data-access/vendor-payments.ts, vendor-store.ts).
library;

int _n(Object? v) => (v as num?)?.round() ?? 0;
int? _nn(Object? v) => (v as num?)?.round();
DateTime? _d(Object? v) => DateTime.tryParse('${v ?? ''}')?.toLocal();
List<Map<String, dynamic>> _list(Object? v) => [
  for (final x in (v as List? ?? const [])) (x as Map).cast<String, dynamic>(),
];

class Payments {
  const Payments({
    required this.totalEarnings,
    required this.amountSettled,
    required this.paymentDue,
    required this.paidOrders,
    required this.unpaidOrders,
    required this.partlyPaidOrders,
    required this.outstandingCorrections,
    required this.settlementCycle,
    required this.commissionPct,
    required this.settlements,
    required this.unpaid,
  });

  factory Payments.fromJson(Map<String, dynamic> j) => Payments(
    totalEarnings: _n(j['totalEarnings']),
    amountSettled: _n(j['amountSettled']),
    paymentDue: _n(j['paymentDue']),
    paidOrders: _n(j['paidOrders']),
    unpaidOrders: _n(j['unpaidOrders']),
    partlyPaidOrders: _n(j['partlyPaidOrders']),
    outstandingCorrections: _n(j['outstandingCorrections']),
    settlementCycle: '${j['settlementCycle'] ?? 'weekly'}',
    commissionPct: (j['commissionPct'] as num?)?.toDouble() ?? 0,
    settlements: _list(j['settlements']).map(SettlementSummary.fromJson).toList(),
    unpaid: _list(j['unpaid']).map(UnpaidOrder.fromJson).toList(),
  );

  final int totalEarnings;
  final int amountSettled;

  /// Positive: Deligro owes the shop. Negative: the shop owes Deligro (cash it kept).
  final int paymentDue;
  final int paidOrders;
  final int unpaidOrders;
  final int partlyPaidOrders;
  final int outstandingCorrections;
  final String settlementCycle;
  final double commissionPct;
  final List<SettlementSummary> settlements;
  final List<UnpaidOrder> unpaid;
}

class SettlementSummary {
  const SettlementSummary({
    required this.id,
    required this.periodLabel,
    required this.orderCount,
    required this.foodGross,
    required this.charges,
    required this.refundsRecovered,
    required this.netPayable,
    required this.status,
    this.paidAt,
    this.paymentRef,
  });

  factory SettlementSummary.fromJson(Map<String, dynamic> j) => SettlementSummary(
    id: '${j['id']}',
    periodLabel: '${j['periodLabel'] ?? ''}',
    orderCount: _n(j['orderCount']),
    foodGross: _n(j['foodGross']),
    charges: _n(j['charges']),
    refundsRecovered: _n(j['refundsRecovered']),
    netPayable: _n(j['netPayable']),
    status: '${j['status'] ?? 'paid'}',
    paidAt: _d(j['paidAt']),
    paymentRef: j['paymentRef'] as String?,
  );

  final String id;
  final String periodLabel;
  final int orderCount;
  final int foodGross;
  final int charges;
  final int refundsRecovered;
  final int netPayable;

  /// `paid` or `void`.
  final String status;
  final DateTime? paidAt;
  final String? paymentRef;
}

class UnpaidOrder {
  const UnpaidOrder({
    required this.orderId,
    required this.code,
    required this.deliveredAt,
    required this.paymentMethod,
    required this.sale,
    required this.charges,
    required this.earnings,
    required this.contribution,
  });

  factory UnpaidOrder.fromJson(Map<String, dynamic> j) => UnpaidOrder(
    orderId: '${j['orderId']}',
    code: '${j['code'] ?? ''}',
    deliveredAt: _d(j['deliveredAt']),
    paymentMethod: '${j['paymentMethod'] ?? 'cod'}',
    sale: _n(j['sale']),
    charges: _n(j['charges']),
    earnings: _n(j['earnings']),
    contribution: _n(j['contribution']),
  );

  final String orderId;
  final String code;
  final DateTime? deliveredAt;
  final String paymentMethod;
  final int sale;
  final int charges;
  final int earnings;

  /// What it adds to the next payout; negative for cash the shop kept.
  final int contribution;
}

class Statement {
  const Statement({
    required this.id,
    required this.shopName,
    required this.periodLabel,
    required this.status,
    required this.paidAt,
    required this.paymentRef,
    required this.paidTo,
    required this.commissionPct,
    required this.commissionGstPct,
    required this.otherChargesPerOrder,
    required this.foodGross,
    required this.commission,
    required this.commissionGst,
    required this.otherCharges,
    required this.refundsRecovered,
    required this.netPayable,
    required this.lines,
  });

  factory Statement.fromJson(Map<String, dynamic> j) => Statement(
    id: '${j['id']}',
    shopName: '${j['shopName'] ?? ''}',
    periodLabel: '${j['periodLabel'] ?? ''}',
    status: '${j['status'] ?? 'paid'}',
    paidAt: _d(j['paidAt']),
    paymentRef: j['paymentRef'] as String?,
    paidTo: j['paidTo'] as String?,
    commissionPct: (j['commissionPct'] as num?)?.toDouble() ?? 0,
    commissionGstPct: (j['commissionGstPct'] as num?)?.toDouble() ?? 0,
    otherChargesPerOrder: _n(j['otherChargesPerOrder']),
    foodGross: _n(j['foodGross']),
    commission: _n(j['commission']),
    commissionGst: _n(j['commissionGst']),
    otherCharges: _n(j['otherCharges']),
    refundsRecovered: _n(j['refundsRecovered']),
    netPayable: _n(j['netPayable']),
    lines: _list(j['lines']).map(StatementLine.fromJson).toList(),
  );

  final String id;
  final String shopName;
  final String periodLabel;
  final String status;
  final DateTime? paidAt;
  final String? paymentRef;
  final String? paidTo;
  final double commissionPct;
  final double commissionGstPct;
  final int otherChargesPerOrder;
  final int foodGross;
  final int commission;
  final int commissionGst;
  final int otherCharges;
  final int refundsRecovered;
  final int netPayable;
  final List<StatementLine> lines;
}

class StatementLine {
  const StatementLine({
    required this.orderId,
    required this.code,
    required this.deliveredAt,
    required this.paymentMethod,
    required this.sale,
    required this.platformDiscount,
    required this.commission,
    required this.commissionGst,
    required this.otherCharges,
    required this.refundRecovered,
    required this.earnings,
    required this.contribution,
  });

  factory StatementLine.fromJson(Map<String, dynamic> j) => StatementLine(
    orderId: '${j['orderId']}',
    code: '${j['code'] ?? ''}',
    deliveredAt: _d(j['deliveredAt']),
    paymentMethod: '${j['paymentMethod'] ?? 'cod'}',
    sale: _n(j['sale']),
    platformDiscount: _n(j['platformDiscount']),
    commission: _n(j['commission']),
    commissionGst: _n(j['commissionGst']),
    otherCharges: _n(j['otherCharges']),
    refundRecovered: _n(j['refundRecovered']),
    earnings: _n(j['earnings']),
    contribution: _n(j['contribution']),
  );

  final String orderId;
  final String code;
  final DateTime? deliveredAt;
  final String paymentMethod;
  final int sale;
  final int platformDiscount;
  final int commission;
  final int commissionGst;
  final int otherCharges;
  final int refundRecovered;
  final int earnings;
  final int contribution;

  int get charges => commission + commissionGst + otherCharges;
}

/// The sales report's filters, sent as query parameters.
class ReportQuery {
  const ReportQuery({
    required this.from,
    required this.to,
    this.status = 'all',
    this.payment = 'all',
    this.settled = 'all',
  });

  /// IST calendar dates, both inclusive (YYYY-MM-DD).
  final String from;
  final String to;
  final String status;
  final String payment;
  final String settled;

  ReportQuery copyWith({String? from, String? to, String? status, String? payment, String? settled}) => ReportQuery(
    from: from ?? this.from,
    to: to ?? this.to,
    status: status ?? this.status,
    payment: payment ?? this.payment,
    settled: settled ?? this.settled,
  );

  Map<String, String> toQuery() => {'from': from, 'to': to, 'status': status, 'payment': payment, 'settled': settled};

  @override
  bool operator ==(Object other) =>
      other is ReportQuery &&
      other.from == from &&
      other.to == to &&
      other.status == status &&
      other.payment == payment &&
      other.settled == settled;

  @override
  int get hashCode => Object.hash(from, to, status, payment, settled);
}

class ReportRow {
  const ReportRow({
    required this.orderId,
    required this.code,
    required this.createdAt,
    required this.stage,
    required this.paymentMethod,
    required this.paymentStatus,
    required this.total,
    required this.sale,
    required this.vendorDiscount,
    this.charges,
    this.earnings,
    this.settlement,
  });

  factory ReportRow.fromJson(Map<String, dynamic> j) => ReportRow(
    orderId: '${j['orderId']}',
    code: '${j['code'] ?? ''}',
    createdAt: _d(j['createdAt']),
    stage: '${j['stage'] ?? ''}',
    paymentMethod: '${j['paymentMethod'] ?? 'cod'}',
    paymentStatus: '${j['paymentStatus'] ?? 'pending'}',
    total: _n(j['total']),
    sale: _n(j['sale']),
    vendorDiscount: _n(j['vendorDiscount']),
    charges: _nn(j['charges']),
    earnings: _nn(j['earnings']),
    settlement: j['settlement'] as String?,
  );

  final String orderId;
  final String code;
  final DateTime? createdAt;
  final String stage;
  final String paymentMethod;
  final String paymentStatus;
  final int total;
  final int sale;
  final int vendorDiscount;
  final int? charges;
  final int? earnings;
  final String? settlement;
}

class ReportTotals {
  const ReportTotals({
    required this.orders,
    required this.completed,
    required this.cancelled,
    required this.inProgress,
    required this.sales,
    required this.vendorDiscounts,
    required this.codOrders,
    required this.onlineOrders,
    required this.cancelledValue,
    this.charges,
    this.earnings,
    this.settled,
    this.unsettled,
  });

  factory ReportTotals.fromJson(Map<String, dynamic> j) => ReportTotals(
    orders: _n(j['orders']),
    completed: _n(j['completed']),
    cancelled: _n(j['cancelled']),
    inProgress: _n(j['inProgress']),
    sales: _n(j['sales']),
    vendorDiscounts: _n(j['vendorDiscounts']),
    codOrders: _n(j['codOrders']),
    onlineOrders: _n(j['onlineOrders']),
    cancelledValue: _n(j['cancelledValue']),
    charges: _nn(j['charges']),
    earnings: _nn(j['earnings']),
    settled: _nn(j['settled']),
    unsettled: _nn(j['unsettled']),
  );

  final int orders;
  final int completed;
  final int cancelled;
  final int inProgress;
  final int sales;
  final int vendorDiscounts;
  final int codOrders;
  final int onlineOrders;
  final int cancelledValue;

  /// Null when the shop's earnings are switched off.
  final int? charges;
  final int? earnings;
  final int? settled;
  final int? unsettled;
}

class SalesReport {
  const SalesReport({
    required this.from,
    required this.to,
    required this.shop,
    required this.rows,
    required this.totals,
    required this.includesMoney,
  });

  factory SalesReport.fromJson(Map<String, dynamic> j) => SalesReport(
    from: '${j['from']}',
    to: '${j['to']}',
    shop: '${j['shop'] ?? ''}',
    rows: _list(j['rows']).map(ReportRow.fromJson).toList(),
    totals: ReportTotals.fromJson(((j['totals'] as Map?) ?? const {}).cast<String, dynamic>()),
    includesMoney: j['includesMoney'] == true,
  );

  final String from;
  final String to;
  final String shop;
  final List<ReportRow> rows;
  final ReportTotals totals;
  final bool includesMoney;
}

class InvoiceProfile {
  const InvoiceProfile({required this.name, this.address, this.phone, this.gstin, this.fssai});

  factory InvoiceProfile.fromJson(Map<String, dynamic> j) => InvoiceProfile(
    name: '${j['name'] ?? ''}',
    address: j['address'] as String?,
    phone: j['phone'] as String?,
    gstin: j['gstin'] as String?,
    fssai: j['fssai'] as String?,
  );

  final String name;
  final String? address;
  final String? phone;
  final String? gstin;
  final String? fssai;
}
