// Fixture help desk, inbox and safety for the debug-only preview. Imported
// only from state/support.dart behind `fixturesEnabled`, which is a
// compile-time false in a release build, so none of this is in the release app.
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../models/inbox.dart';
import '../../models/support.dart';
import '../notifications_repository.dart';
import '../safety_repository.dart';
import '../support_repository.dart';

/// Which safety session a fixture build is (`--dart-define=FIXTURE_SAFETY=`):
/// `online` (an alert goes through), `offline` (the server cannot be reached:
/// "Not sent yet") or `nocontact` (online, and the rider has no emergency
/// contact saved).
const String fixtureSafetyScenario = String.fromEnvironment(
  'FIXTURE_SAFETY',
  defaultValue: 'online',
);

/// Carried by the fixture ticket text, unique so a release build can be
/// searched for it to prove the fixtures are not in it.
const fixtureSupportMarker = 'FXT-SUPPORT-7C1';

void _noRelease(bool releaseMode) {
  assert(!kReleaseMode, 'the fixture backend must never be built in a release build');
  if (releaseMode) {
    throw StateError('the fixture backend is not available in a release build');
  }
}

String _iso(DateTime t) => t.toUtc().toIso8601String();

/// [SupportRepository] over in-memory tickets.
class FixtureSupportRepository implements SupportRepository {
  FixtureSupportRepository._(DateTime now) : _now = now {
    _tickets = [
      _ticket(1042, 'accident_emergency', 'Accident or emergency', 'emergency', 'In progress',
          'in_progress', now.subtract(const Duration(hours: 5)), 'Fell near the market, bike fine'),
      _ticket(1038, 'customer_unreachable', 'Customer unreachable', 'normal', 'Waiting for your reply',
          'waiting_on_requester', now.subtract(const Duration(days: 1, hours: 3)),
          'Customer not picking up. $fixtureSupportMarker'),
      _ticket(1031, 'delivery_payment', 'Delivery payment issue', 'normal', 'Resolved', 'resolved',
          now.subtract(const Duration(days: 6)), 'Payout shows 4 deliveries, I did 5'),
    ];
  }

  factory FixtureSupportRepository.create({
    DateTime? now,
    @visibleForTesting bool releaseMode = kReleaseMode,
  }) {
    _noRelease(releaseMode);
    return FixtureSupportRepository._(now ?? DateTime.now());
  }

  final DateTime _now;
  late List<Map<String, dynamic>> _tickets;
  final _replies = <String, List<Map<String, dynamic>>>{};
  var _created = 0;

  Map<String, dynamic> _ticket(
    int number,
    String category,
    String label,
    String priority,
    String statusLabel,
    String status,
    DateTime at,
    String subject,
  ) => {
    'id': 'f7000000-0000-4000-8000-${number.toString().padLeft(12, '0')}',
    'number': number,
    'category': category,
    'categoryLabel': label,
    'priority': priority,
    'subject': subject,
    'status': status,
    'statusLabel': statusLabel,
    'orderId': null,
    'orderCode': number == 1038 ? '#A1B2C3' : null,
    'createdAt': _iso(at),
    'updatedAt': _iso(at.add(const Duration(minutes: 40))),
    'resolvedAt': status == 'resolved' ? _iso(at.add(const Duration(hours: 20))) : null,
  };

  static const _categories = [
    ('vendor_not_handing_over', 'Shop not handing over the order'),
    ('customer_unreachable', 'Customer unreachable'),
    ('incorrect_address', 'Incorrect address'),
    ('delivery_payment', 'Delivery payment issue'),
    ('cash_reconciliation', 'Cash reconciliation'),
    ('accident_emergency', 'Accident or emergency'),
    ('app_technical', 'App or technical problem'),
    ('other', 'Something else'),
  ];

  @override
  Future<SupportOverview> overview() async => SupportOverview.fromJson({
    'tickets': _tickets,
    'contact': {'phone': '+91 98765 43210', 'whatsapp': '+91 98765 43210'},
    'categories': [
      for (final c in _categories) {'key': c.$1, 'label': c.$2},
    ],
    'safetyCategories': const [],
  });

  Map<String, dynamic>? _find(String id) => _tickets.where((t) => t['id'] == id).firstOrNull;

  @override
  Future<TicketThread> thread(String id) async {
    final t = _find(id);
    if (t == null) throw ApiException(404, 'not_found');
    final at = DateTime.parse(t['createdAt'] as String);
    return TicketThread.fromJson({
      'ticket': {...t, 'lat': null, 'lng': null, 'locationUrl': null},
      'messages': [
        {
          'id': 'm1',
          'body': t['subject'],
          'fromStaff': false,
          'authorRole': 'rider',
          'attachments': const [],
          'createdAt': _iso(at),
        },
        {
          'id': 'm2',
          'body': t['number'] == 1038
              ? 'We tried the customer too. Please wait 5 minutes at the gate and tell us if they come out.'
              : 'Thanks for telling us. A manager is looking at this now.',
          'fromStaff': true,
          'authorRole': 'manager',
          'attachments': const [],
          'createdAt': _iso(at.add(const Duration(minutes: 40))),
        },
        ...(_replies[id] ?? const []),
      ],
    });
  }

  @override
  Future<CreatedTicket> create({
    required String category,
    String? subject,
    required String message,
    String? orderId,
    List<File> photos = const [],
    double? lat,
    double? lng,
  }) async {
    final label = _categories.where((c) => c.$1 == category).firstOrNull?.$2 ?? category;
    final emergency = category == 'accident_emergency';
    final number = 1050 + (++_created);
    final t = _ticket(number, category, label, emergency ? 'emergency' : 'normal', 'Open', 'open',
        _now, (subject ?? '').isNotEmpty ? subject! : message);
    _tickets = [t, ..._tickets];
    return CreatedTicket(id: t['id'] as String, number: number, priority: t['priority'] as String);
  }

  @override
  Future<void> reply(String id, String message, {List<File> photos = const []}) async {
    if (_find(id) == null) throw ApiException(404, 'not_found');
    _replies.putIfAbsent(id, () => []).add({
      'id': 'r${_replies[id]?.length ?? 0}',
      'body': message,
      'fromStaff': false,
      'authorRole': 'rider',
      'attachments': const [],
      'createdAt': _iso(DateTime.now()),
    });
  }

  @override
  Future<List<RecentOrder>> recentOrders() async => const [
    RecentOrder(orderId: 'f1000000-0000-4000-8000-000000000001', code: '#A1B2C3', shop: 'Sharma Sweets'),
    RecentOrder(orderId: 'f1000000-0000-4000-8000-000000000002', code: '#D4E5F6', shop: 'Pizza Corner'),
  ];
}

/// [NotificationsRepository] over in-memory notifications.
class FixtureNotificationsRepository implements NotificationsRepository {
  FixtureNotificationsRepository._(DateTime now) {
    Map<String, dynamic> n(String id, String category, String title, String body, Duration ago,
        {bool read = false, String? url}) =>
        {
          'id': id,
          'category': category,
          'title': title,
          'body': body,
          'data': {'url': ?url},
          'read': read,
          'readAt': read ? _iso(now.subtract(ago)) : null,
          'createdAt': _iso(now.subtract(ago)),
        };
    _items = [
      n('f8000000-0000-4000-8000-000000000001', 'support', 'Reply on ticket #1038',
          'We tried the customer too. Please wait 5 minutes at the gate.', const Duration(minutes: 25),
          url: '/help/tickets/f7000000-0000-4000-8000-000000001038'),
      n('f8000000-0000-4000-8000-000000000002', 'pickup_reminders', 'Order #A1B2C3 is ready',
          'Sharma Sweets has it packed. Head over when you can.', const Duration(hours: 2), url: '/jobs'),
      n('f8000000-0000-4000-8000-000000000003', 'payouts', 'Payout recorded',
          'A payout of ₹4,000 was recorded on 15 Oct.', const Duration(hours: 4), read: true, url: '/earnings/payouts'),
      n('f8000000-0000-4000-8000-000000000004', 'delivery_updates', 'Delivery instructions changed',
          'Customer says: leave it with the guard at gate 2.', const Duration(days: 1, hours: 1),
          read: true, url: '/jobs'),
      n('f8000000-0000-4000-8000-000000000005', 'cancellations', 'Order #D4E5F6 was cancelled',
          'The customer cancelled before pickup. Nothing more to do.', const Duration(days: 2),
          read: true, url: '/jobs'),
      n('f8000000-0000-4000-8000-000000000006', 'high_demand', 'Busy in your area',
          'Orders are waiting for riders near the station.', const Duration(days: 4), read: true, url: '/home'),
    ];
    _announcements = [
      {
        'id': 'f9000000-0000-4000-8000-000000000001',
        'audience': 'rider',
        'title': 'Diwali week: stores close early',
        'body': 'Many shops close by 8 pm on 29 and 30 October. Plan your last pickups earlier.',
        'startsAt': _iso(now.subtract(const Duration(days: 1))),
        'endsAt': _iso(now.add(const Duration(days: 8))),
      },
    ];
  }

  factory FixtureNotificationsRepository.create({
    DateTime? now,
    @visibleForTesting bool releaseMode = kReleaseMode,
  }) {
    _noRelease(releaseMode);
    return FixtureNotificationsRepository._(now ?? DateTime.now());
  }

  late List<Map<String, dynamic>> _items;
  late List<Map<String, dynamic>> _announcements;
  NotificationPrefs _prefs = const NotificationPrefs();

  int get _unread => _items.where((e) => e['read'] != true).length;

  @override
  Future<InboxPage> inbox({String? before, int limit = 30}) async => InboxPage.fromJson({
    'available': true,
    'notifications': _items,
    'unread': _unread,
    'hasMore': false,
    'nextBefore': null,
  });

  @override
  Future<void> markRead(List<String> ids) async {
    _items = [
      for (final e in _items) ids.contains(e['id']) ? {...e, 'read': true} : e,
    ];
  }

  @override
  Future<void> markAllRead() async {
    _items = [for (final e in _items) {...e, 'read': true}];
  }

  @override
  Future<List<Announcement>> announcements() async => [
    for (final a in _announcements) Announcement.fromJson(a),
  ];

  @override
  Future<NotificationPrefs?> loadPrefs() async => _prefs;

  @override
  Future<void> savePrefs(NotificationPrefs prefs) async => _prefs = prefs;
}

/// [SafetyRepository] for a fixture session: an alert goes through, or fails
/// as a dead connection does, per [fixtureSafetyScenario].
class FixtureSafetyRepository implements SafetyRepository {
  FixtureSafetyRepository._(this._scenario);

  factory FixtureSafetyRepository.create({
    String scenario = fixtureSafetyScenario,
    @visibleForTesting bool releaseMode = kReleaseMode,
  }) {
    _noRelease(releaseMode);
    return FixtureSafetyRepository._(scenario);
  }

  final String _scenario;

  @override
  Future<SosAck> sos({
    required SosKind kind,
    double? lat,
    double? lng,
    String? note,
    String? orderId,
    List<File> photos = const [],
  }) async {
    if (_scenario == 'offline') throw ApiException(0, 'network');
    return const SosAck(ticketId: 'f7000000-0000-4000-8000-000000001060', number: 1060, deduped: false);
  }

  @override
  Future<EmergencyContact?> emergencyContact() async => _scenario == 'nocontact'
      ? null
      : const EmergencyContact(name: 'Sunita Kumar', phone: '+91 91234 56780', relation: 'Wife');
}
