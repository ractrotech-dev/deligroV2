import '../core/api.dart';
import '../models/finance.dart';
import '../models/outcome.dart';
import '../models/payment_request.dart';
import '../models/settlement.dart';

/// Finance (§7) — `/api/manager/finance/*`, one method per endpoint.
abstract interface class FinanceRepository {
  Future<FinanceOverview> overview(FinanceQuery q);
  Future<VendorDuesPage> vendorDues({String? zoneId, bool delayedOnly = false, String? cursor});
  Future<RiderDuesPage> riderDues({String? zoneId, bool delayedOnly = false, String? cursor});
  Future<FinanceIssuePage> issues(FinanceQuery q, {FinanceIssueType? type, String? cursor});
  Future<RiderPayoutPage> riderPayouts(FinanceQuery q, {String? riderId, String? cursor});
  Future<SettlementPage> settlements(SettlementFilters f, {String? cursor});
  Future<SettlementDetail> settlement(String id);

  /// 201 → [Applied]; 409 `nothing_to_pay` / `negative_net` / `duplicate_pending`
  /// / `already_settled`, 403, 404 → [Refused]; faults throw (Retry re-sends
  /// the same `clientActionId`).
  Future<Outcome<SettlementInitiated>> initiateSettlement(SettlementInitiation d);

  /// Asks for a paid settlement to be reversed. Nothing changes until a different
  /// person approves it. 409 `not_paid` / `duplicate_pending`, 400, 403, 404 →
  /// [Refused]; faults throw (Retry re-sends the same `clientActionId`).
  Future<Outcome<PaymentRequest>> requestSettlementReversal(String id, SettlementReversal r);

  Future<Reconciliation> reconciliation(FinanceQuery q, ReconSection section, {String? state, String? cursor});
}

class ApiFinanceRepository implements FinanceRepository {
  ApiFinanceRepository(this._api);
  final ApiClient _api;

  static const _base = '/api/manager/finance';

  @override
  Future<FinanceOverview> overview(FinanceQuery q) async =>
      FinanceOverview.fromJson(await _api.get('$_base/overview', query: q.toQuery()));

  @override
  Future<VendorDuesPage> vendorDues({String? zoneId, bool delayedOnly = false, String? cursor}) async =>
      VendorDuesPage.fromJson(await _api.get('$_base/vendor-dues',
          query: {'zone': ?zoneId, if (delayedOnly) 'delayed': '1', 'cursor': ?cursor}));

  @override
  Future<RiderDuesPage> riderDues({String? zoneId, bool delayedOnly = false, String? cursor}) async =>
      RiderDuesPage.fromJson(await _api.get('$_base/rider-dues',
          query: {'zone': ?zoneId, if (delayedOnly) 'delayed': '1', 'cursor': ?cursor}));

  @override
  Future<FinanceIssuePage> issues(FinanceQuery q, {FinanceIssueType? type, String? cursor}) async =>
      FinanceIssuePage.fromJson(await _api.get('$_base/issues',
          query: {...q.toQuery(), if (type != null && type != FinanceIssueType.unknown) 'type': type.wire, 'cursor': ?cursor}));

  @override
  Future<RiderPayoutPage> riderPayouts(FinanceQuery q, {String? riderId, String? cursor}) async =>
      RiderPayoutPage.fromJson(
          await _api.get('$_base/rider-payouts', query: {...q.toQuery(), 'rider': ?riderId, 'cursor': ?cursor}));

  @override
  Future<SettlementPage> settlements(SettlementFilters f, {String? cursor}) async =>
      SettlementPage.fromJson(await _api.get('$_base/settlements', query: {...f.toQuery(), 'cursor': ?cursor}));

  @override
  Future<SettlementDetail> settlement(String id) async =>
      SettlementDetail.fromJson(await _api.get('$_base/settlements/${Uri.encodeComponent(id)}'));

  @override
  Future<Outcome<SettlementInitiated>> initiateSettlement(SettlementInitiation d) =>
      runAction(() => _api.post('$_base/settlements', d.toJson()), SettlementInitiated.fromJson);

  @override
  Future<Outcome<PaymentRequest>> requestSettlementReversal(String id, SettlementReversal r) => runAction(
        () => _api.post('$_base/settlements/${Uri.encodeComponent(id)}/reverse', r.toJson()),
        (res) => res['request'] is Map ? PaymentRequest.fromJson((res['request'] as Map).cast<String, dynamic>()) : null,
      );

  @override
  Future<Reconciliation> reconciliation(FinanceQuery q, ReconSection section, {String? state, String? cursor}) async =>
      Reconciliation.fromJson(await _api.get('$_base/reconciliation', query: {
        ...q.toQuery(),
        'section': section.wire,
        'state': ?state,
        'cursor': ?cursor,
      }));
}
