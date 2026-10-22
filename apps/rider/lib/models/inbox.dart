/// The notification inbox, announcements and the rider's per-category
/// switches (`/api/rider/notifications`, `/announcements`, and the server's
/// `src/lib/rider/notification-prefs.ts`). English only.
library;

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v)?.toLocal() : null;

class InboxItem {
  const InboxItem({
    required this.id,
    required this.category,
    required this.title,
    required this.body,
    this.data = const {},
    required this.read,
    this.createdAt,
  });

  final String id;
  final String category;
  final String title;
  final String body;

  /// `url` (the route a tap opens), `orderId`, `ticketId`, ...
  final Map<String, dynamic> data;
  final bool read;
  final DateTime? createdAt;

  InboxItem asRead() => InboxItem(
        id: id,
        category: category,
        title: title,
        body: body,
        data: data,
        read: true,
        createdAt: createdAt,
      );

  factory InboxItem.fromJson(Map<String, dynamic> j) => InboxItem(
        id: '${j['id']}',
        category: '${j['category'] ?? ''}',
        title: '${j['title'] ?? ''}',
        body: '${j['body'] ?? ''}',
        data: j['data'] is Map ? Map<String, dynamic>.from(j['data'] as Map) : const {},
        read: j['read'] == true || j['readAt'] != null,
        createdAt: _date(j['createdAt']),
      );
}

/// One page of the inbox.
class InboxPage {
  const InboxPage({
    required this.items,
    required this.unread,
    required this.hasMore,
    this.nextBefore,
    this.available = true,
  });

  final List<InboxItem> items;
  final int unread;
  final bool hasMore;
  final String? nextBefore;

  /// False when the server has no inbox yet (the list is empty, not broken).
  final bool available;

  static const empty = InboxPage(items: [], unread: 0, hasMore: false);

  factory InboxPage.fromJson(Map<String, dynamic> j) => InboxPage(
        items: [
          for (final e in (j['notifications'] as List? ?? const []))
            if (e is Map) InboxItem.fromJson(Map<String, dynamic>.from(e)),
        ],
        unread: (j['unread'] as num?)?.toInt() ?? 0,
        hasMore: j['hasMore'] == true,
        nextBefore: j['nextBefore'] as String?,
        available: j['available'] != false,
      );
}

class Announcement {
  const Announcement({required this.id, required this.title, required this.body, this.startsAt, this.endsAt});

  final String id;
  final String title;
  final String body;
  final DateTime? startsAt;
  final DateTime? endsAt;

  factory Announcement.fromJson(Map<String, dynamic> j) => Announcement(
        id: '${j['id']}',
        title: '${j['title'] ?? ''}',
        body: '${j['body'] ?? ''}',
        startsAt: _date(j['startsAt']),
        endsAt: _date(j['endsAt']),
      );
}

/// A notification category as Settings lists it.
class NotificationCategory {
  const NotificationCategory(this.key, this.title, this.hint, {this.locked = false});

  final String key;
  final String title;
  final String hint;

  /// Cannot be switched off: a missed offer is a missed job, and safety is safety.
  final bool locked;
}

/// The twelve categories, in the order the server lists them
/// (`NOTIFICATION_CATEGORIES`); offers, cancellations and safety are locked on.
const notificationCategories = [
  NotificationCategory('offers', 'New job offers', 'Always on. A missed offer is a missed job.', locked: true),
  NotificationCategory('cancellations', 'Cancelled or reassigned orders', 'Always on, so you never go to a shop for nothing.', locked: true),
  NotificationCategory('safety', 'Safety alerts', 'Always on.', locked: true),
  NotificationCategory('pickup_reminders', 'Pickup reminders', 'When an order is ready and you have not arrived.'),
  NotificationCategory('delivery_updates', 'Delivery updates',
      'Changed instructions, delay alerts, the shop confirming your pickup, and answers to your reports and requests (such as manual pickup or delivering without the code).'),
  NotificationCategory('payouts', 'Payouts', 'When a payout is recorded.'),
  NotificationCategory('incentives', 'Incentives', 'When you earn one.'),
  NotificationCategory('announcements', 'Announcements', 'News from Deligro.'),
  NotificationCategory('support', 'Support replies', 'Replies and status changes on your tickets.'),
  NotificationCategory('cash', 'Cash reminders', 'Cash to deposit, and when a deposit is confirmed or disputed.'),
  NotificationCategory('documents', 'Document reminders',
      'Documents about to expire, and decisions on your documents, profile changes and verification.'),
  NotificationCategory('high_demand', 'High demand', 'When orders are waiting for riders.'),
];

bool isLockedCategory(String key) => notificationCategories.any((c) => c.key == key && c.locked);

/// The rider's switches: every category on unless explicitly switched off,
/// and a locked one always on whatever was stored.
class NotificationPrefs {
  const NotificationPrefs([this.off = const {}]);

  /// Categories switched off.
  final Set<String> off;

  bool isOn(String key) => isLockedCategory(key) || !off.contains(key);

  NotificationPrefs set(String key, bool on) {
    if (isLockedCategory(key)) return this;
    final next = {...off};
    on ? next.remove(key) : next.add(key);
    return NotificationPrefs(next);
  }

  /// The body of the save: every switchable category as an explicit boolean
  /// (`true` removes the key on the server, `false` stores it). Locked
  /// categories are never sent.
  Map<String, bool> toJson() => {
        for (final c in notificationCategories)
          if (!c.locked) c.key: isOn(c.key),
      };

  /// Reads `{category: bool}` (the server's answer for every category, or the
  /// copy kept on the phone): only an explicit `false` is off.
  factory NotificationPrefs.fromJson(Object? j) {
    if (j is! Map) return const NotificationPrefs();
    return NotificationPrefs({
      for (final e in j.entries)
        if (e.value == false && !isLockedCategory('${e.key}')) '${e.key}',
    });
  }
}
