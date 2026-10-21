import '../config/env.dart';
import '../core/api.dart';
import '../models/account.dart';
import '../models/dashboard.dart';
import '../models/stats.dart';
import '../models/manager_me.dart';

/// The Manager app's own routes (`/api/manager/*`) and the shared ones it uses.
class ManagerRepository {
  ManagerRepository(this._api);
  final ApiClient _api;

  Future<ManagerMe> me() async => ManagerMe.fromJson(await _api.get('/api/manager/me'));

  /// Business statistics for a period (§2).
  Future<StatsData> stats(StatsQuery q) async =>
      StatsData.fromJson(await _api.get('/api/manager/stats', query: q.toQuery()));

  /// The eighteen figures (§1) for all of this person's zones, or one of them.
  Future<DashboardData> dashboard({String? zoneId}) async => DashboardData.fromJson(
        await _api.get('/api/manager/dashboard', query: {'zone': ?zoneId}),
      );

  Future<List<PermissionInfo>> permissions() async {
    final res = await _api.get('/api/manager/permissions');
    return [
      for (final p in (res['permissions'] as List?) ?? const [])
        if (p is Map) PermissionInfo.fromJson(p.cast<String, dynamic>()),
    ];
  }

  Future<ActivityPage> activity({int page = 1, int pageSize = 50}) async {
    final res = await _api.get('/api/manager/activity', query: {'page': '$page', 'pageSize': '$pageSize'});
    return ActivityPage(
      items: [
        for (final i in (res['items'] as List?) ?? const [])
          if (i is Map) ActivityItem.fromJson(i.cast<String, dynamic>()),
      ],
      page: (res['page'] as num?)?.toInt() ?? page,
      hasMore: res['hasMore'] == true,
    );
  }

  Future<List<SessionInfo>> sessions() async {
    final res = await _api.get('/api/manager/sessions');
    return [
      for (final s in (res['sessions'] as List?) ?? const [])
        if (s is Map) SessionInfo.fromJson(s.cast<String, dynamic>()),
    ];
  }

  Future<void> revokeSession(String id) => _api.delete('/api/manager/sessions', {'id': id});

  /// Ends every session, this one included. The caller signs out locally after.
  Future<void> signOutEverywhere() => _api.delete('/api/manager/sessions', {'all': true});

  /// Changes the password and ends every other session. Returns true when the
  /// password changed but other devices could not be signed out — the person
  /// has to end them from Devices.
  Future<bool> changePassword(String current, String next) async {
    final res = await _api.post('/api/manager/password', {'current': current, 'next': next});
    return res['warning'] == 'other_sessions_still_signed_in';
  }

  Future<List<AlertKindPref>> notificationPrefs() async {
    final res = await _api.get('/api/manager/notification-prefs');
    final prefs = (res['prefs'] as Map?) ?? const {};
    return [
      for (final k in (res['kinds'] as List?) ?? const [])
        if (k is Map)
          AlertKindPref(
            kind: '${k['kind']}',
            en: '${k['en'] ?? k['kind']}',
            push: prefs['${k['kind']}'] != false,
          ),
    ];
  }

  Future<void> setNotificationPref(String kind, bool push) =>
      _api.put('/api/manager/notification-prefs', {'kind': kind, 'push': push});

  /// Null when the check itself fails — an update prompt is never worth an error.
  Future<AppVersionInfo?> appVersion() async {
    try {
      final res = await _api.get('/api/app-version', query: {
        'app': Env.releaseApp,
        'versionCode': '${Env.versionCode}',
      });
      return AppVersionInfo.fromJson(res);
    } catch (_) {
      return null;
    }
  }

  /// Ties OneSignal's subscription to this account for ops pushes.
  Future<void> registerPush(String playerId) =>
      _api.post('/api/notifications/register', {'playerId': playerId});
}
