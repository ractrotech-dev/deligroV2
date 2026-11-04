import '../core/api.dart';
import '../models/wallet.dart';

/// The customer's wallet. Everything goes through the website's API: the balance column
/// isn't readable from the app's own session, and nothing here can move a point.
class WalletRepository {
  WalletRepository(this._api);
  final ApiClient _api;

  Future<WalletInfo> wallet({String? cursor}) async {
    final res = await _api.get('/api/wallet', query: cursor == null ? null : {'cursor': cursor});
    return WalletInfo.fromJson(Map<String, dynamic>.from(res['wallet'] as Map));
  }

  /// A new code for the customer's own cash delivery. It exists only in this answer.
  /// Asking again replaces the last one.
  Future<String> changeCode(String orderId) async {
    final res = await _api.post('/api/orders/$orderId/wallet-code');
    return '${res['code']}';
  }
}
