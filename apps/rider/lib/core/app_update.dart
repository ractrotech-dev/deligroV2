import '../config/env.dart';
import 'api.dart';

typedef AppUpdate = ({bool updateAvailable, bool forceUpdate, String apkUrl, String notes});

/// `/api/app-version` — admins publish the rider APK in Admin → Settings.
/// Null when the check fails: an update prompt must never block the app.
Future<AppUpdate?> fetchAppUpdate(ApiClient api) async {
  try {
    final res = await api.get(
      '/api/app-version',
      query: {'app': 'rider', 'versionCode': '${Env.versionCode}'},
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
