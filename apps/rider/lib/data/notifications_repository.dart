import '../core/api.dart';
import '../models/inbox.dart';

/// The inbox, announcements and notification switches.
/// [ApiNotificationsRepository] talks to the website; a debug build can swap
/// in the fixture backend (data/fixtures/fixture_support.dart).
///
/// Every method throws [ApiException]: 429, 503 or a dead connection.
abstract interface class NotificationsRepository {
  /// `GET /api/rider/notifications`, newest first. [before] is the previous
  /// page's `nextBefore`.
  Future<InboxPage> inbox({String? before, int limit = 30});

  /// `POST /api/rider/notifications` `{action: 'read', ids}`.
  Future<void> markRead(List<String> ids);

  /// `POST /api/rider/notifications` `{action: 'read_all'}`.
  Future<void> markAllRead();

  /// `GET /api/rider/announcements`: what is live now, newest first.
  Future<List<Announcement>> announcements();

  /// The switches the server holds (`rider_profiles.notification_prefs`), or
  /// null when it does not say (the app then keeps its own copy).
  Future<NotificationPrefs?> loadPrefs();

  /// Saves the switches server-side, where the push sender reads them.
  /// Throws when the server does not take them.
  Future<void> savePrefs(NotificationPrefs prefs);
}

class ApiNotificationsRepository implements NotificationsRepository {
  ApiNotificationsRepository(this._api);

  final ApiClient _api;

  @override
  Future<InboxPage> inbox({String? before, int limit = 30}) async {
    final res = await _api.get(
      '/api/rider/notifications',
      query: {'limit': '$limit', 'before': ?before},
    );
    try {
      return InboxPage.fromJson(res);
    } on FormatException {
      throw ApiException(500, 'bad_response');
    } on TypeError {
      throw ApiException(500, 'bad_response');
    }
  }

  @override
  Future<void> markRead(List<String> ids) async {
    if (ids.isEmpty) return;
    await _api.post('/api/rider/notifications', {'action': 'read', 'ids': ids});
  }

  @override
  Future<void> markAllRead() async {
    await _api.post('/api/rider/notifications', {'action': 'read_all'});
  }

  @override
  Future<List<Announcement>> announcements() async {
    final res = await _api.get('/api/rider/announcements');
    return [
      for (final a in (res['announcements'] as List? ?? const []))
        if (a is Map) Announcement.fromJson(Map<String, dynamic>.from(a)),
    ];
  }

  // The preference endpoint: the server stream exposes none of its own, so
  // the switches ride on the Phase 6 profile route
  // (`GET/PATCH /api/rider/profile`, key `notificationPrefs`).
  @override
  Future<NotificationPrefs?> loadPrefs() async {
    final res = await _api.get('/api/rider/profile');
    final profile = res['profile'];
    if (profile is Map && profile.containsKey('notificationPrefs')) {
      return NotificationPrefs.fromJson(profile['notificationPrefs']);
    }
    return null;
  }

  @override
  Future<void> savePrefs(NotificationPrefs prefs) async {
    await _api.patch('/api/rider/profile', {'notificationPrefs': prefs.toJson()});
  }
}
