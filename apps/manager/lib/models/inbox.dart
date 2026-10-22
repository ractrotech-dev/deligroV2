import 'json_util.dart';

/// The in-app inbox (`/api/manager/notifications`): every alert and ticket
/// notice this manager was sent, read or not.
class InboxItem {
  const InboxItem({
    required this.id,
    required this.category,
    required this.title,
    this.body = '',
    this.data = const {},
    this.readAt,
    this.createdAt,
  });

  factory InboxItem.fromJson(Map<String, dynamic> j) => InboxItem(
        id: jStrOr(j['id']),
        category: jStrOr(j['category'], 'system'),
        title: jStrOr(j['title']),
        body: jStrOr(j['body']),
        data: jMap(j['data']) ?? const {},
        readAt: jDate(j['readAt']),
        createdAt: jDate(j['createdAt']),
      );

  final String id;
  final String category;
  final String title;
  final String body;
  final Map<String, dynamic> data;
  final DateTime? readAt;
  final DateTime? createdAt;

  bool get isUnread => readAt == null;
  String? get url => jStr(data['url']);
  String? get alertId => jStr(data['alertId']);

  InboxItem markedRead(DateTime at) =>
      InboxItem(id: id, category: category, title: title, body: body, data: data, readAt: readAt ?? at, createdAt: createdAt);
}

class InboxPage {
  const InboxPage({required this.items, this.nextCursor, this.unread = 0});

  factory InboxPage.fromJson(Map<String, dynamic> j) => InboxPage(
        items: [for (final i in jMaps(j['items'])) InboxItem.fromJson(i)],
        nextCursor: jStr(j['nextCursor']),
        unread: jInt(j['unread']),
      );

  final List<InboxItem> items;
  final String? nextCursor;
  final int unread;
}

/// The bell: unread inbox rows, and the open and critical alert counts.
class UnreadCount {
  const UnreadCount({this.unread = 0, this.openAlerts = 0, this.criticalAlerts = 0});

  factory UnreadCount.fromJson(Map<String, dynamic> j) => UnreadCount(
        unread: jInt(j['unread']),
        openAlerts: jInt(j['openAlerts']),
        criticalAlerts: jInt(j['criticalAlerts']),
      );

  final int unread;
  final int openAlerts;
  final int criticalAlerts;
}
