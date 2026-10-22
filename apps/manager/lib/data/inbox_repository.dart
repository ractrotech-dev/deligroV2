import '../core/api.dart';
import '../models/inbox.dart';

/// The in-app inbox — `/api/manager/notifications*`.
abstract interface class InboxRepository {
  Future<InboxPage> list({String? cursor, bool unreadOnly = false});
  Future<UnreadCount> unreadCount();

  /// Marks [ids] (or everything) read; returns the unread count after.
  Future<int> markRead({List<String>? ids, bool all = false});
}

class ApiInboxRepository implements InboxRepository {
  ApiInboxRepository(this._api);
  final ApiClient _api;

  static const _base = '/api/manager/notifications';

  @override
  Future<InboxPage> list({String? cursor, bool unreadOnly = false}) async =>
      InboxPage.fromJson(await _api.get(_base, query: {'cursor': ?cursor, if (unreadOnly) 'unread': '1'}));

  @override
  Future<UnreadCount> unreadCount() async => UnreadCount.fromJson(await _api.get('$_base/unread-count'));

  @override
  Future<int> markRead({List<String>? ids, bool all = false}) async {
    final res = await _api.post('$_base/read', all ? {'all': true} : {'ids': ids ?? const []});
    return res['unread'] is num ? (res['unread'] as num).round() : 0;
  }
}
