import '../core/api.dart';

/// What the server said about adding change to a customer's wallet.
class WalletChangeResult {
  const WalletChangeResult.added({required int this.change, required int this.received}) : error = null;
  const WalletChangeResult.refused(String this.error)
      : change = null,
        received = null;

  final int? change;
  final int? received;

  /// A sentence for the rider, when it was refused.
  final String? error;

  bool get ok => error == null;
}

/// "No change? Add to wallet" (`POST /api/rider/deliveries/:id/wallet-change`). Not in
/// the offline queue: the rider has to know the answer before leaving the door, and a
/// rider who can't get one gives the change in cash and finishes the delivery.
abstract interface class WalletChangeRepository {
  Future<WalletChangeResult> add(String orderId, {required int received, required String code, required String actionId});
}

class ApiWalletChangeRepository implements WalletChangeRepository {
  ApiWalletChangeRepository(this._api);
  final ApiClient _api;

  @override
  Future<WalletChangeResult> add(String orderId, {required int received, required String code, required String actionId}) async {
    try {
      final res = await _api.post('/api/rider/deliveries/$orderId/wallet-change', {
        'received': received,
        'code': code,
        'actionId': actionId,
      });
      return WalletChangeResult.added(
        change: (res['change'] as num).round(),
        received: (res['received'] as num).round(),
      );
    } on ApiException catch (e) {
      if (e.code == 'feature_disabled') {
        return const WalletChangeResult.refused('This isn\'t switched on for you. Give the change in cash.');
      }
      if (e.status == 404) return const WalletChangeResult.refused('This isn\'t your delivery any more.');
      if (e.status == 409 && e.message != null) return WalletChangeResult.refused(e.message!);
      if (e.status == 429) return const WalletChangeResult.refused('Too many tries. Wait a minute.');
      return const WalletChangeResult.refused('Couldn\'t reach Deligro. Check your signal, or give the change in cash.');
    } catch (_) {
      return const WalletChangeResult.refused('Couldn\'t reach Deligro. Check your signal, or give the change in cash.');
    }
  }
}

/// A debug build started with FIXTURES=true: the code is 123456.
class FixtureWalletChangeRepository implements WalletChangeRepository {
  @override
  Future<WalletChangeResult> add(String orderId, {required int received, required String code, required String actionId}) async {
    if (code != '123456') return const WalletChangeResult.refused('Wrong code. 4 tries left.');
    return WalletChangeResult.added(change: received > 485 ? received - 485 : 0, received: received);
  }
}
