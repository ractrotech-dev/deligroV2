import 'package:deligro_manager/data/finance_repository.dart';
import 'package:deligro_manager/data/reports_repository.dart';
import 'package:deligro_manager/models/finance.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/report.dart';
import 'package:deligro_manager/models/settlement.dart';

import '../fixtures/fixtures.dart';

Map<String, dynamic> p6(String name) => apiFixture('phase6/$name');

T? _pop<T>(List<T> q) => q.isEmpty ? null : q.removeAt(0);

/// Answers from the Phase 6 fixtures and records every call.
class FakeFinanceRepository implements FinanceRepository {
  FinanceOverview overviewData = FinanceOverview.fromJson(p6('finance_overview'));
  VendorDuesPage vendorDuesPage = VendorDuesPage.fromJson(p6('vendor_dues'));
  RiderDuesPage riderDuesPage = RiderDuesPage.fromJson(p6('rider_dues'));
  FinanceIssuePage issuePage = FinanceIssuePage.fromJson(p6('finance_issues'));
  RiderPayoutPage payoutPage = RiderPayoutPage.fromJson(p6('rider_payouts'));
  SettlementPage settlementPage = SettlementPage.fromJson(p6('settlements_list'));
  SettlementDetail detail = SettlementDetail.fromJson(p6('settlement_detail'));
  RefundPage refundPage = RefundPage.fromJson(p6('refunds'));
  final recon = {
    ReconSection.orders: Reconciliation.fromJson(p6('reconciliation_orders')),
    ReconSection.online: Reconciliation.fromJson(p6('reconciliation_online')),
    ReconSection.cash: Reconciliation.fromJson(p6('reconciliation_cash')),
  };

  /// Thrown by the next read (then cleared), e.g. a 403 or a network fault.
  Object? readError;
  Object? decideError;
  final List<Outcome<SettlementInitiated>> initiateOutcomes = [];
  final List<Outcome<RefundItem>> refundOutcomes = [];

  final overviewCalls = <FinanceQuery>[];
  final vendorDuesCalls = <({String? zoneId, bool delayed})>[];
  final riderDuesCalls = <({String? zoneId, bool delayed})>[];
  final settlementCalls = <SettlementFilters>[];
  final initiateCalls = <SettlementInitiation>[];
  final refundCalls = <({RefundStatus? status})>[];
  final decideCalls = <({String id, RefundDecision decision})>[];
  final reconCalls = <({ReconSection section, String? state})>[];
  final issueCalls = <FinanceIssueType?>[];

  void _maybeThrow() {
    final e = readError;
    if (e != null) {
      readError = null;
      throw e;
    }
  }

  @override
  Future<FinanceOverview> overview(FinanceQuery q) async {
    overviewCalls.add(q);
    _maybeThrow();
    return overviewData;
  }

  @override
  Future<VendorDuesPage> vendorDues({String? zoneId, bool delayedOnly = false, String? cursor}) async {
    vendorDuesCalls.add((zoneId: zoneId, delayed: delayedOnly));
    _maybeThrow();
    if (!delayedOnly) return vendorDuesPage;
    return VendorDuesPage(items: vendorDuesPage.items.where((d) => d.delayed).toList());
  }

  @override
  Future<RiderDuesPage> riderDues({String? zoneId, bool delayedOnly = false, String? cursor}) async {
    riderDuesCalls.add((zoneId: zoneId, delayed: delayedOnly));
    _maybeThrow();
    if (!delayedOnly) return riderDuesPage;
    return RiderDuesPage(items: riderDuesPage.items.where((d) => d.delayed).toList());
  }

  @override
  Future<FinanceIssuePage> issues(FinanceQuery q, {FinanceIssueType? type, String? cursor}) async {
    issueCalls.add(type);
    _maybeThrow();
    return issuePage;
  }

  @override
  Future<RiderPayoutPage> riderPayouts(FinanceQuery q, {String? riderId, String? cursor}) async {
    _maybeThrow();
    return payoutPage;
  }

  @override
  Future<SettlementPage> settlements(SettlementFilters f, {String? cursor}) async {
    settlementCalls.add(f);
    _maybeThrow();
    return settlementPage;
  }

  @override
  Future<SettlementDetail> settlement(String id) async {
    _maybeThrow();
    return detail;
  }

  @override
  Future<Outcome<SettlementInitiated>> initiateSettlement(SettlementInitiation d) async {
    initiateCalls.add(d);
    return _pop(initiateOutcomes) ?? Applied(SettlementInitiated.fromJson(p6('settlement_initiated')));
  }

  @override
  Future<RefundPage> refunds(FinanceQuery q, {RefundStatus? status, String? cursor}) async {
    refundCalls.add((status: status));
    _maybeThrow();
    return refundPage;
  }

  @override
  Future<Outcome<RefundItem>> decideRefund(String id, RefundDecision d) async {
    decideCalls.add((id: id, decision: d));
    final e = decideError;
    if (e != null) {
      decideError = null;
      throw e;
    }
    return _pop(refundOutcomes) ?? Applied(refundPage.items.firstWhere((r) => r.id == id));
  }

  @override
  Future<Reconciliation> reconciliation(FinanceQuery q, ReconSection section, {String? state, String? cursor}) async {
    reconCalls.add((section: section, state: state));
    _maybeThrow();
    return recon[section]!;
  }
}

class FakeReportsRepository implements ReportsRepository {
  FakeReportsRepository({bool finance = true})
      : kindList = ReportKindList.fromJson(p6(finance ? 'report_kinds' : 'report_kinds_no_finance'));

  ReportKindList kindList;
  ReportPayload payload = ReportPayload.fromJson(p6('report_sales'));

  /// Thrown by the next export (`all`) call, e.g. [ReportTooLarge].
  Object? exportError;
  final runCalls = <({ReportQuery q, bool all})>[];

  @override
  Future<ReportKindList> kinds() async => kindList;

  @override
  Future<ReportPayload> run(ReportQuery q, {bool all = false}) async {
    runCalls.add((q: q, all: all));
    final e = exportError;
    if (all && e != null) {
      exportError = null;
      throw e;
    }
    return payload;
  }
}
