/// Build-time config, passed with `--dart-define-from-file=env/prod.json`.
/// Only public values belong here: the Supabase anon/publishable key is
/// protected by RLS; the service-role key must never ship in an app.
class Env {
  static const supabaseUrl = String.fromEnvironment('SUPABASE_URL');
  static const supabaseAnonKey = String.fromEnvironment('SUPABASE_ANON_KEY');
  static const siteUrl = String.fromEnvironment(
    'SITE_URL',
    defaultValue: 'https://deligrodelivery.ractrotech.com',
  );
  static const oneSignalAppId = String.fromEnvironment('ONESIGNAL_APP_ID');

  /// Must match pubspec `version: x.y.z+<code>`; sent to /api/app-version.
  static const versionCode = 3;
  static const versionName = '2.1.0';

  /// The release track on `/api/app-version` (migration 0141).
  static const releaseApp = 'manager';

  /// Sent as `x-client` so server logs can tell the apps apart.
  static const clientId = 'deligro-manager-flutter/$versionCode';

  static bool get configured =>
      supabaseUrl.isNotEmpty && supabaseAnonKey.isNotEmpty;
}
