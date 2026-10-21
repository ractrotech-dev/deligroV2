import 'package:deligro_manager/models/finance.dart';
import 'package:deligro_manager/models/payment_request.dart';
import 'package:deligro_manager/models/report.dart';
import 'package:deligro_manager/models/settlement.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fixtures/fixtures.dart';

Map<String, dynamic> p6(String name) => apiFixture('phase6/$name');

void main() {
  test('finance overview parses every §7 figure', () {
    final o = FinanceOverview.fromJson(p6('finance_overview'));
    expect(o.filters.from, '2026-10-01');
    expect(o.filters.zone?.name, 'Bemetara');
    expect(o.sales.grossSales, 182340);
    expect(o.sales.netSales, 171220);
    expect(o.sales.discounts.vendor, 4200);
    expect(o.sales.discounts.platform, 6920);
    expect(o.sales.refunds.amount, 3450);
    expect(o.sales.refunds.count, 7);
    expect(o.sales.correctionsOutstanding.amount, 120);
    expect(o.sales.commission.total, 32273);
    expect(o.sales.commission.commissionGst, 4923);
    expect(o.sales.deliveryFees, 9420);
    // Rider money keeps paise; order money is whole rupees.
    expect(o.sales.riderEarnings, 48000.50);
    expect(o.sales.riderPayable, isA<double>());
    expect(o.sales.vendorPayable, isA<int>());
    expect(o.sales.cancelled.count, 12);
    expect(o.payments.vendorPaid.count, 9);
    expect(o.payments.riderPaid.amount, 48000.0);
    expect(o.payments.issuesWarning, 3);
    expect(o.payments.issuesCritical, 1);
    expect(o.payments.pendingApprovals, 2);
    expect(o.series, hasLength(3));
    expect(o.series.last.netSales, 5400);
    expect(o.generatedAt, DateTime.utc(2026, 10, 21, 9, 30));
  });

  test('overview with no rider ledger rows and all zones', () {
    final o = FinanceOverview.fromJson(p6('finance_overview_no_rider'));
    expect(o.filters.zone, isNull);
    expect(o.sales.riderEarnings, 0);
    expect(o.payments.riderPaid.count, 0);
    expect(o.series, isEmpty);
  });

  test('a missing block parses as empty, not a crash', () {
    final o = FinanceOverview.fromJson({'filters': {'from': '2026-10-01', 'to': '2026-10-02'}});
    expect(o.sales.grossSales, 0);
    expect(o.payments.pendingApprovals, 0);
  });

  test('vendor and rider dues', () {
    final v = VendorDuesPage.fromJson(p6('vendor_dues'));
    expect(v.items, hasLength(3));
    expect(v.items.first.delayed, isTrue);
    expect(v.items.first.cycle, 'weekly');
    expect(v.items[1].pendingRequestId, 'pr-9');
    expect(v.items[2].zone, isNull);
    expect(v.items[2].recoverable, 340);
    expect(v.totalPayable, 8220);
    final r = RiderDuesPage.fromJson(p6('rider_dues'));
    expect(r.items.first.unpaid, 12000.50);
    expect(r.items.first.lastPayout?.reference, 'UTR998877');
    expect(r.items[1].lastPayout, isNull);
    expect(r.items[1].rider.code, isNull);
    expect(r.totalPayable, 21000.50);
  });

  test('every issue type parses; an unknown one maps to unknown', () {
    final p = FinanceIssuePage.fromJson(p6('finance_issues'));
    expect(p.items.map((i) => i.type).toSet(), containsAll(FinanceIssueType.values));
    final odd = p.items.last;
    expect(odd.type, FinanceIssueType.unknown);
    expect(odd.severity, IssueSeverity.warning);
    expect(odd.subject.kind, IssueSubjectKind.unknown);
    expect(p.counts[FinanceIssueType.settlementDelayed], 1);
    expect(p.items.firstWhere((i) => i.type == FinanceIssueType.approvalOverdue).severity, IssueSeverity.critical);
  });

  test('settlement list, detail with a pending request, and initiation', () {
    final l = SettlementPage.fromJson(p6('settlements_list'));
    expect(l.items.map((s) => s.status), [SettlementStatus.paid, SettlementStatus.draft, SettlementStatus.voided]);
    expect(l.items.first.paymentRef, 'UTR1234567890ABC');
    expect(l.items.first.paidBy?.name, 'Vikram');
    expect(l.items[1].awaitingApproval, isTrue);
    expect(l.items[2].kind, SettlementKind.instant);
    expect(l.totalNetPayable, 17039);

    final d = SettlementDetail.fromJson(p6('settlement_detail'));
    expect(d.lines, hasLength(2));
    expect(d.lines.last.contribution, -177);
    expect(d.corrections.single.status, CorrectionStatus.outstanding);
    expect(d.request?.kind, PaymentKind.vendorSettlement);
    expect(d.request?.settlementId, 's-2');
    expect(d.request?.selfApproved, isFalse);
    expect(d.stale, isFalse);

    final i = SettlementInitiated.fromJson(p6('settlement_initiated'));
    expect(i.settlement.netPayable, 6420);
    expect(i.request.settlementId, 's-4');
  });

  test('an initiation body carries exactly one of period or order', () {
    final byPeriod = SettlementInitiation(vendorId: 'v-1', from: DateTime(2026, 10, 8), to: DateTime(2026, 10, 14), method: PayMethod.bank);
    final j = byPeriod.toJson();
    expect(j['from'], '2026-10-08');
    expect(j['to'], '2026-10-14');
    expect(j['orderId'], isNull);
    expect(j['clientActionId'], isNotEmpty);
    final byOrder = SettlementInitiation(vendorId: 'v-1', orderId: 'o-1', method: PayMethod.upi, note: '  ');
    final k = byOrder.toJson();
    expect(k.containsKey('from'), isFalse);
    expect(k['orderId'], 'o-1');
    expect(k['note'], isNull);
  });

  test('rider payouts, refunds', () {
    final p = RiderPayoutPage.fromJson(p6('rider_payouts'));
    expect(p.items.first.rider.code, 'DR-0007');
    expect(p.items.first.payout.reference, 'UTR998877');
    expect(p.totalAmount, 21000.50);
    final r = RefundPage.fromJson(p6('refunds'));
    expect(r.pendingCount, 1);
    expect(r.items.first.status, RefundStatus.pending);
    expect(r.items.first.origin, RefundOrigin.customer);
    expect(r.items.last.settlementEffect, 'correction_created');
    expect(r.items.last.decidedBy?.name, 'Vikram');
  });

  test('every reconciliation section', () {
    final o = Reconciliation.fromJson(p6('reconciliation_orders'));
    expect(o.section, ReconSection.orders);
    expect(o.summary['paid_matched'], 210);
    expect(o.orderItems.first.state, 'paid_mismatch');
    expect(o.orderItems.first.difference, -120);
    expect(o.orderItems.last.settled, isNull);
    final on = Reconciliation.fromJson(p6('reconciliation_online'));
    expect(on.onlineItems.single.paidAmount, 500);
    final c = Reconciliation.fromJson(p6('reconciliation_cash'));
    expect(c.cashItems.last.status, 'disputed');
    expect(c.cashItems.first.depositIds, ['d-1']);
    expect(c.managers.single.handedOn, 9000);
    expect(c.summary['pending'], 2200);
  });

  test('report kinds; the no-finance list carries no finance kinds', () {
    final all = ReportKindList.fromJson(p6('report_kinds'));
    expect(all.kinds, hasLength(13));
    expect(all.kinds.firstWhere((k) => k.kind == 'orders').statusOptions, contains('delivered'));
    final limited = ReportKindList.fromJson(p6('report_kinds_no_finance'));
    expect(limited.kinds.map((k) => k.kind), isNot(contains('commission')));
  });

  test('a report payload with null cells, a totals row and an unknown column type', () {
    final r = ReportPayload.fromJson(p6('report_sales'));
    expect(r.generatedBy, 'Asha Verma');
    expect(r.generatedAt, DateTime.utc(2026, 10, 21, 9, 30));
    expect(r.filters.vendor?.name, 'Spice Hub');
    expect(r.filters.payment, 'online');
    expect(r.columns.first.type, ReportColumnType.date);
    expect(r.rows[1]['note'], isNull);
    expect(r.totals?['orders'], 46);
    expect(r.highlights.first.value, 17610);
    expect(r.notes.single, contains('Cancelled'));
    expect(ReportColumn.fromJson({'key': 'x', 'label': 'X', 'type': 'parsecs'}).type, ReportColumnType.unknown);
    final e = ReportPayload.fromJson(p6('report_empty'));
    expect(e.rows, isEmpty);
    expect(e.totalRows, 0);
  });

  test('a report query sends only what it has', () {
    final q = ReportQuery(kind: 'orders', from: '2026-10-01', to: '2026-10-21', vendorId: 'v-1', status: 'delivered');
    expect(q.toQuery(), {
      'kind': 'orders',
      'from': '2026-10-01',
      'to': '2026-10-21',
      'vendor': 'v-1',
      'status': 'delivered',
      'page': '1',
      'pageSize': '50',
    });
    expect(q.toQuery(all: true)['all'], '1');
    expect(q.toQuery(all: true).containsKey('page'), isFalse);
  });

  test('payment requests for settlements carry settlementId and the self-approved mark', () {
    final p = PaymentRequestPage.fromJson(p6('payment_requests_settlement'));
    expect(p.items.first.settlementId, 's-2');
    expect(p.items.last.selfApproved, isTrue);
    // Phase 5 rider payouts have neither.
    final r = PaymentRequest.fromJson({'id': 'x', 'kind': 'rider_payout'});
    expect(r.settlementId, isNull);
    expect(r.selfApproved, isFalse);
  });
}
