import '../core/api.dart';
import '../models/cash.dart';
import '../models/outcome.dart';

/// Rider cash deposits and disputes — `/api/manager/cash/*`.
abstract interface class CashRepository {
  Future<CashDepositPage> deposits({String? status, String? riderId, String? cursor});
  Future<CashDisputePage> disputes({String? status, String? cursor});

  /// A 60-second signed URL for a deposit's receipt photo.
  Future<String> depositPhotoUrl(String id);

  /// 400 `note_required`, 409 `already_decided` → [Refused].
  Future<Outcome<CashDeposit>> decideDeposit(String id, DepositDecision d);

  /// 409 `already_resolved` → [Refused].
  Future<Outcome<CashDispute>> resolveDispute(String id, DisputeResolution r);
}

class ApiCashRepository implements CashRepository {
  ApiCashRepository(this._api);
  final ApiClient _api;

  @override
  Future<CashDepositPage> deposits({String? status, String? riderId, String? cursor}) async =>
      CashDepositPage.fromJson(await _api.get('/api/manager/cash/deposits', query: {
        'status': ?status,
        'rider': ?riderId,
        'cursor': ?cursor,
      }));

  @override
  Future<CashDisputePage> disputes({String? status, String? cursor}) async => CashDisputePage.fromJson(
        await _api.get('/api/manager/cash/disputes', query: {'status': ?status, 'cursor': ?cursor}),
      );

  @override
  Future<String> depositPhotoUrl(String id) async =>
      '${(await _api.get('/api/manager/cash/deposits/${Uri.encodeComponent(id)}/photo'))['url']}';

  @override
  Future<Outcome<CashDeposit>> decideDeposit(String id, DepositDecision d) => runAction(
        () => _api.post('/api/manager/cash/deposits/${Uri.encodeComponent(id)}/decide', d.toJson()),
        (res) => res['deposit'] is Map ? CashDeposit.fromJson((res['deposit'] as Map).cast<String, dynamic>()) : null,
      );

  @override
  Future<Outcome<CashDispute>> resolveDispute(String id, DisputeResolution r) => runAction(
        () => _api.post('/api/manager/cash/disputes/${Uri.encodeComponent(id)}/resolve', r.toJson()),
        (res) => res['dispute'] is Map ? CashDispute.fromJson((res['dispute'] as Map).cast<String, dynamic>()) : null,
      );
}
