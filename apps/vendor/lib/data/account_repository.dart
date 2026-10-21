import '../config/env.dart';
import '../core/api.dart';

typedef AppVersion = ({bool updateAvailable, bool forceUpdate, String apkUrl, String notes});

class AccountRepository {
  AccountRepository(this._api);

  final ApiClient _api;

  /// Ties OneSignal's subscription to this account for order pushes and the ring.
  Future<void> registerPush(String playerId) =>
      _api.post('/api/notifications/register', {'playerId': playerId});

  /// The Partner release track (admin Settings → App releases → Partner app).
  /// Null when the check itself fails: an unreachable server never blocks work.
  Future<AppVersion?> appVersion() async {
    try {
      final res = await _api.get(
        '/api/app-version',
        query: {'app': Env.releaseApp, 'versionCode': '${Env.versionCode}'},
      );
      return (
        updateAvailable: res['updateAvailable'] == true,
        forceUpdate: res['forceUpdate'] == true,
        apkUrl: '${res['apkUrl'] ?? ''}',
        notes: '${res['releaseNotes'] ?? ''}',
      );
    } catch (_) {
      return null;
    }
  }
}
