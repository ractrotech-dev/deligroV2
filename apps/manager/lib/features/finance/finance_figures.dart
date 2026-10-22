import '../../core/format.dart';
import '../../models/finance.dart';

/// How a figure reads at a glance.
enum FigureTone { normal, warning, critical }

/// One line of the Finance overview: the document's words, the figure, a
/// line of detail, and where tapping it goes.
class FinanceFigure {
  const FinanceFigure(this.label, this.value, {this.detail, this.route, this.tone = FigureTone.normal});
  final String label;
  final String value;
  final String? detail;
  final String? route;
  final FigureTone tone;
}

String _plural(int n, String one, [String? many]) => '$n ${n == 1 ? one : (many ?? '${one}s')}';

/// §7 "Sales and commission", in the document's order and words.
List<FinanceFigure> salesFigures(FinanceOverview o) {
  final s = o.sales;
  final adj = [
    _plural(s.refunds.count, 'refund'),
    if (s.correctionsOutstanding.count > 0)
      'corrections outstanding ${rupees(s.correctionsOutstanding.amount)} (${s.correctionsOutstanding.count})',
    if (s.correctionsApplied.count > 0)
      'applied ${rupees(s.correctionsApplied.amount)} (${s.correctionsApplied.count})',
  ];
  return [
    FinanceFigure('Total gross sales', rupees(s.grossSales), detail: 'Customers paid ${rupees(s.customerPaid)}'),
    FinanceFigure(
      'Net sales',
      rupees(s.netSales),
      detail: 'Cancelled orders kept apart: ${count(s.cancelled.count)} · ${rupees(s.cancelled.amount)}',
    ),
    FinanceFigure(
      'Platform commission',
      rupees(s.commission.total),
      detail: 'Commission ${rupees(s.commission.commission)} · GST ${rupees(s.commission.commissionGst)}'
          ' · other charges ${rupees(s.commission.otherCharges)}',
    ),
    FinanceFigure('Vendor-funded discounts', rupees(s.discounts.vendor)),
    FinanceFigure('Deligro-funded discounts', rupees(s.discounts.platform)),
    FinanceFigure('Refunds and adjustments', rupees(s.refunds.amount),
        detail: adj.join(' · '), route: '/finance/refunds'),
    FinanceFigure('Delivery fees collected', rupees(s.deliveryFees)),
    FinanceFigure('Rider delivery earnings', rupeesFlex(s.riderEarnings), detail: 'From the rider ledger (salary records)'),
    FinanceFigure(
      'Vendor earnings payable',
      rupees(s.vendorPayable),
      detail: s.vendorRecoverable > 0 ? 'Shops owe Deligro ${rupees(s.vendorRecoverable)}' : 'As of now',
      route: '/finance/vendor-dues',
    ),
    FinanceFigure('Rider earnings payable', rupeesFlex(s.riderPayable), detail: 'As of now', route: '/finance/rider-dues'),
  ];
}

/// §7 "Payment tracking", in the document's order and words.
List<FinanceFigure> paymentFigures(FinanceOverview o) {
  final p = o.payments;
  return [
    FinanceFigure('Vendor payments due', rupees(p.vendorDue), detail: 'As of now', route: '/finance/vendor-dues'),
    FinanceFigure('Vendor payments completed', rupees(p.vendorPaid.amount),
        detail: _plural(p.vendorPaid.count, 'settlement'), route: '/finance/settlements?status=paid'),
    FinanceFigure('Rider payouts due', rupeesFlex(p.riderDue), detail: 'As of now', route: '/finance/rider-dues'),
    FinanceFigure('Rider payouts completed', rupeesFlex(p.riderPaid.amount),
        detail: _plural(p.riderPaid.count, 'payout'), route: '/finance/rider-payouts'),
    FinanceFigure(
      'Failed or delayed transactions',
      count(p.issues),
      detail: '${p.issuesCritical} critical · ${_plural(p.issuesWarning, 'warning')}',
      route: '/finance/issues',
      tone: p.issuesCritical > 0 ? FigureTone.critical : (p.issuesWarning > 0 ? FigureTone.warning : FigureTone.normal),
    ),
    FinanceFigure('Pending approvals', count(p.pendingApprovals),
        route: '/more/approvals?kind=vendor_settlement',
        tone: p.pendingApprovals > 0 ? FigureTone.warning : FigureTone.normal),
  ];
}
