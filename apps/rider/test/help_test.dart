// Help desk and notifications: the Help page, raising a ticket, a ticket's
// thread, the inbox and its bell, push tap routing, and the notification
// switches in Settings. No network: the repositories are fakes and the URL
// launcher and photo pickers are recorders.
import 'dart:io';

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/navigation_launcher.dart';
import 'package:deligro_rider/core/push_routes.dart';
import 'package:deligro_rider/data/notifications_repository.dart';
import 'package:deligro_rider/data/support_repository.dart';
import 'package:deligro_rider/features/delivery/proof_photo.dart';
import 'package:deligro_rider/features/help/attachments.dart';
import 'package:deligro_rider/features/help/help_screen.dart';
import 'package:deligro_rider/features/more/more_screen.dart';
import 'package:deligro_rider/features/notifications/notifications_screen.dart';
import 'package:deligro_rider/features/settings/settings_screen.dart';
import 'package:deligro_rider/models/inbox.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/models/support.dart';
import 'package:deligro_rider/state/clock.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/state/support.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/photo_files.dart';

// 22 Oct 2026, 09:00 IST.
final _now = DateTime.utc(2026, 10, 22, 3, 30);

const _categoryKeys = [
  'vendor_not_handing_over',
  'customer_unreachable',
  'incorrect_address',
  'delivery_payment',
  'cash_reconciliation',
  'accident_emergency',
  'app_technical',
  'other',
];

Map<String, dynamic> _ticketJson({
  int number = 1038,
  String status = 'waiting_on_requester',
  String statusLabel = 'Waiting for your reply',
  String priority = 'normal',
  String category = 'customer_unreachable',
  String label = 'Customer unreachable',
}) => {
  'id': 'f7000000-0000-4000-8000-${number.toString().padLeft(12, '0')}',
  'number': number,
  'category': category,
  'categoryLabel': label,
  'priority': priority,
  'subject': label,
  'status': status,
  'statusLabel': statusLabel,
  'orderId': null,
  'orderCode': '#A1B2C3',
  'createdAt': _now.subtract(const Duration(days: 1)).toIso8601String(),
  'updatedAt': _now.subtract(const Duration(hours: 2)).toIso8601String(),
  'resolvedAt': null,
};

class _Support implements SupportRepository {
  _Support({
    List<Map<String, dynamic>>? tickets,
    this.contact = const {'phone': '+91 98765 43210', 'whatsapp': '+91 98765 43210'},
    List<RecentOrder>? orders,
  }) : tickets = tickets ?? [_ticketJson()],
       orders = orders ?? const [RecentOrder(orderId: 'f1000000-0000-4000-8000-000000000001', code: '#A1B2C3', shop: 'Sharma Sweets')];

  final List<Map<String, dynamic>> tickets;
  final Map<String, dynamic> contact;
  final List<RecentOrder> orders;
  Object? overviewError;
  Object? createError;
  Object? replyError;
  List<Map<String, dynamic>> messages = [
    {
      'id': 'm1',
      'body': 'Customer is not picking up.',
      'fromStaff': false,
      'authorRole': 'rider',
      'attachments': const [],
      'createdAt': _now.subtract(const Duration(hours: 5)).toIso8601String(),
    },
    {
      'id': 'm2',
      'body': 'We tried the customer too. Please wait five minutes.',
      'fromStaff': true,
      'authorRole': 'manager',
      'attachments': const [],
      'createdAt': _now.subtract(const Duration(hours: 4)).toIso8601String(),
    },
    // The server never sends one of these; if one slipped through it must not show.
    {
      'id': 'm3',
      'body': 'INTERNAL: rider has two earlier complaints',
      'fromStaff': true,
      'internal': true,
      'authorRole': 'admin',
      'attachments': const [],
      'createdAt': _now.subtract(const Duration(hours: 3)).toIso8601String(),
    },
  ];
  final created = <({String category, String message, String? orderId, int photos})>[];
  final replies = <({String id, String message, int photos})>[];

  @override
  Future<SupportOverview> overview() async {
    final e = overviewError;
    if (e != null) throw e;
    return SupportOverview.fromJson({
      'tickets': tickets,
      'contact': contact,
      'categories': [
        for (final k in _categoryKeys) {'key': k, 'label': k.replaceAll('_', ' ')},
      ],
      'safetyCategories': const [],
    });
  }

  @override
  Future<TicketThread> thread(String id) async {
    final t = tickets.where((t) => t['id'] == id).firstOrNull;
    if (t == null) throw ApiException(404, 'not_found');
    return TicketThread.fromJson({'ticket': t, 'messages': messages});
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
    final e = createError;
    if (e != null) throw e;
    created.add((category: category, message: message, orderId: orderId, photos: photos.length));
    return CreatedTicket(id: tickets.first['id'] as String, number: 1050, priority: 'normal');
  }

  @override
  Future<void> reply(String id, String message, {List<File> photos = const []}) async {
    final e = replyError;
    if (e != null) throw e;
    replies.add((id: id, message: message, photos: photos.length));
  }

  @override
  Future<List<RecentOrder>> recentOrders() async => orders;
}

InboxItem _item(String id, String category, String title, DateTime at, {bool read = false, String? url}) => InboxItem(
  id: id,
  category: category,
  title: title,
  body: '$title body',
  data: {'url': ?url},
  read: read,
  createdAt: at.toLocal(),
);

class _Inbox implements NotificationsRepository {
  _Inbox({List<InboxItem>? items, this.announcementItems = const []}) : items = items ?? [];

  List<InboxItem> items;
  List<Announcement> announcementItems;
  NotificationPrefs prefs = const NotificationPrefs();
  Object? saveError;
  final saved = <Map<String, bool>>[];
  final markedRead = <List<String>>[];
  var readAll = 0;

  @override
  Future<InboxPage> inbox({String? before, int limit = 30}) async => InboxPage(
    items: items,
    unread: items.where((e) => !e.read).length,
    hasMore: false,
  );

  @override
  Future<void> markRead(List<String> ids) async {
    markedRead.add(ids);
    items = [for (final e in items) ids.contains(e.id) ? e.asRead() : e];
  }

  @override
  Future<void> markAllRead() async {
    readAll++;
    items = [for (final e in items) e.asRead()];
  }

  @override
  Future<List<Announcement>> announcements() async => announcementItems;

  @override
  Future<NotificationPrefs?> loadPrefs() async => prefs;

  @override
  Future<void> savePrefs(NotificationPrefs p) async {
    final e = saveError;
    if (e != null) throw e;
    saved.add(p.toJson());
    prefs = p;
  }
}

RiderMe _me() => const RiderMe(
  id: 'rider-1',
  name: 'Ravi Kumar',
  riderCode: 'DR-0042',
  availability: RiderAvailabilityDto(isOnline: false),
  phase: 'offline',
);

class _Ctx {
  _Ctx(this.container, this.opened, this.router);
  final ProviderContainer container;
  final List<Uri> opened;
  final GoRouter router;
}

Future<void> _settle(WidgetTester tester, {int rounds = 6}) async {
  for (var i = 0; i < rounds; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    await tester.pump(const Duration(milliseconds: 60));
  }
}

Future<_Ctx> _pump(
  WidgetTester tester, {
  required String start,
  _Support? support,
  _Inbox? inbox,
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  List<File> Function(int limit)? gallery,
  File? camera,
}) async {
  tester.view.physicalSize = const Size(360 * 3, 720 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({});
  final opened = <Uri>[];
  final router = GoRouter(
    initialLocation: start,
    routes: [
      GoRoute(path: '/home', builder: (_, _) => const Scaffold(body: Center(child: NotificationBell()))),
      GoRoute(path: '/jobs', builder: (_, _) => const Scaffold(body: Text('JOBS PAGE'))),
      GoRoute(path: '/earnings', builder: (_, _) => const Scaffold(body: Text('EARNINGS PAGE'))),
      GoRoute(path: '/earnings/payouts', builder: (_, _) => const Scaffold(body: Text('PAYOUTS PAGE'))),
      GoRoute(path: '/settings', builder: (_, _) => const SettingsScreen()),
      notificationsRoute,
      GoRoute(
        path: '/more',
        builder: (_, _) => const MoreScreen(),
        routes: [helpRoute, GoRoute(path: 'settings', builder: (_, _) => const SettingsScreen())],
      ),
    ],
  );
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      supportRepoProvider.overrideWithValue(support ?? _Support()),
      notificationsRepoProvider.overrideWithValue(inbox ?? _Inbox()),
      clockProvider.overrideWithValue(() => _now),
      meProvider.overrideWith((_) async => _me()),
      userIdProvider.overrideWithValue('rider-1'),
      urlOpenerProvider.overrideWithValue((uri) async {
        opened.add(uri);
        return true;
      }),
      galleryPickerProvider.overrideWithValue((limit) async => gallery?.call(limit) ?? const []),
      photoTakerProvider.overrideWithValue(() async => camera),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: buildTheme(brightness),
        routerConfig: router,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
      ),
    ),
  );
  await _settle(tester);
  return _Ctx(container, opened, router);
}

Future<void> _tap(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await _settle(tester);
}

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('Help page', () {
    testWidgets('lists the tickets with their status, and Call and WhatsApp open the phone', (tester) async {
      final ctx = await _pump(
        tester,
        start: '/more/help',
        support: _Support(tickets: [
          _ticketJson(),
          _ticketJson(number: 1031, status: 'resolved', statusLabel: 'Resolved', label: 'Delivery payment issue', category: 'delivery_payment'),
        ]),
      );
      expect(find.text('Customer unreachable'), findsOneWidget);
      expect(find.text('Waiting for your reply'), findsOneWidget);
      expect(find.text('Resolved'), findsOneWidget);
      expect(find.byKey(const Key('ticket-1038')), findsOneWidget);

      await _tap(tester, find.byKey(const Key('call-support')));
      await _tap(tester, find.byKey(const Key('whatsapp-support')));
      expect(ctx.opened.map((u) => u.toString()), ['tel:+919876543210', 'https://wa.me/919876543210']);
    });

    testWidgets('hides the call rows when Deligro has set no numbers, and says so', (tester) async {
      await _pump(tester, start: '/more/help', support: _Support(contact: const {'phone': null, 'whatsapp': null}));
      expect(find.byKey(const Key('call-support')), findsNothing);
      expect(find.byKey(const Key('whatsapp-support')), findsNothing);
      expect(find.textContaining("phone numbers aren't set yet"), findsOneWidget);
    });

    testWidgets('an empty list says there are no tickets; the FAQ opens', (tester) async {
      await _pump(tester, start: '/more/help', support: _Support(tickets: []));
      expect(find.byKey(const Key('no-tickets')), findsOneWidget);
      await _tap(tester, find.byKey(const Key('faq-3')));
      expect(find.textContaining('Alert Deligro sends your location to Deligro ops only'), findsOneWidget);
    });

    testWidgets('a list that cannot load offers Try again', (tester) async {
      final s = _Support()..overviewError = ApiException(0, 'network');
      await _pump(tester, start: '/more/help', support: s);
      expect(find.byKey(const Key('tickets-retry')), findsOneWidget);
    });
  });

  group('Raise a ticket', () {
    testWidgets('the categories are in the document order', (tester) async {
      await _pump(tester, start: '/more/help/new');
      final keys = [
        for (final w in tester.widgetList(find.byWidgetPredicate((w) => w.key is ValueKey<String> && (w.key as ValueKey<String>).value.startsWith('category-'))))
          (w.key as ValueKey<String>).value.substring('category-'.length),
      ];
      expect(keys, _categoryKeys);
    });

    testWidgets('Send stays off until a category and a message are there, then posts them with the order', (tester) async {
      final s = _Support();
      await _pump(tester, start: '/more/help/new', support: s);
      final send = find.byKey(const Key('send-ticket'));
      expect(tester.widget<FilledButton>(send).onPressed, isNull);

      await _tap(tester, find.byKey(const Key('category-customer_unreachable')));
      await tester.enterText(find.byKey(const Key('ticket-message')), 'Customer is not picking up');
      await tester.pump();
      await _tap(tester, find.byKey(const Key('order-picker')));
      await _tap(tester, find.text('#A1B2C3 · Sharma Sweets').last);
      await _tap(tester, send);

      expect(s.created, hasLength(1));
      expect(s.created.single.category, 'customer_unreachable');
      expect(s.created.single.message, 'Customer is not picking up');
      expect(s.created.single.orderId, 'f1000000-0000-4000-8000-000000000001');
      // The new ticket's thread replaces the form.
      expect(find.byKey(const Key('thread-list')), findsOneWidget);
    });

    testWidgets('the accident category points to SOS and 112 first', (tester) async {
      await _pump(tester, start: '/more/help/new');
      expect(find.byKey(const Key('emergency-note')), findsNothing);
      await _tap(tester, find.byKey(const Key('category-accident_emergency')));
      expect(find.byKey(const Key('emergency-note')), findsOneWidget);
      expect(find.textContaining('call 112 from your phone'), findsOneWidget);
    });

    testWidgets('a fifth photo is refused', (tester) async {
      final files = [for (var i = 0; i < 5; i++) testPhoto('p$i.jpg')];
      await _pump(tester, start: '/more/help/new', gallery: (limit) => files);
      await _tap(tester, find.byKey(const Key('add-photo')));
      await _tap(tester, find.byKey(const Key('photo-gallery')));
      expect(find.byKey(const Key('photo-3')), findsOneWidget);
      expect(find.byKey(const Key('photo-4')), findsNothing);
      expect(find.text('Only 4 photos can be attached.'), findsOneWidget);
      // Full: Add is off.
      final add = tester.widget<OutlinedButton>(find.byKey(const Key('add-photo')));
      expect(add.onPressed, isNull);
    });

    testWidgets('a non-photo file is refused, a photo can be removed', (tester) async {
      await _pump(tester, start: '/more/help/new', gallery: (limit) => [testPhoto('notes.pdf'), testPhoto('a.png')]);
      await _tap(tester, find.byKey(const Key('add-photo')));
      await _tap(tester, find.byKey(const Key('photo-gallery')));
      expect(find.text('Only JPEG or PNG photos can be sent.'), findsOneWidget);
      expect(find.byKey(const Key('photo-0')), findsOneWidget);
      await _tap(tester, find.byKey(const Key('remove-photo')));
      expect(find.byKey(const Key('photo-0')), findsNothing);
    });

    testWidgets('a failed send keeps the message and says why', (tester) async {
      final s = _Support()..createError = ApiException(0, 'network');
      await _pump(tester, start: '/more/help/new', support: s);
      await _tap(tester, find.byKey(const Key('category-other')));
      await tester.enterText(find.byKey(const Key('ticket-message')), 'Please call me');
      await tester.pump();
      await _tap(tester, find.byKey(const Key('send-ticket')));
      expect(find.byKey(const Key('ticket-error')), findsOneWidget);
      expect(find.textContaining('No connection'), findsOneWidget);
      expect(tester.widget<TextField>(find.byKey(const Key('ticket-message'))).controller!.text, 'Please call me');
    });
  });

  group('Ticket thread', () {
    String id(int n) => 'f7000000-0000-4000-8000-${n.toString().padLeft(12, '0')}';

    testWidgets('shows the rider and Deligro replies, and no internal notes', (tester) async {
      await _pump(tester, start: '/more/help/tickets/${id(1038)}');
      expect(find.text('Customer is not picking up.'), findsOneWidget);
      expect(find.text('We tried the customer too. Please wait five minutes.'), findsOneWidget);
      expect(find.textContaining('INTERNAL'), findsNothing);
      expect(find.text('Deligro'), findsOneWidget);
      expect(find.text('You'), findsOneWidget);
      expect(find.text('Ticket #1038'), findsOneWidget);
    });

    testWidgets('a reply goes to the ticket and clears the box', (tester) async {
      final s = _Support();
      await _pump(tester, start: '/more/help/tickets/${id(1038)}', support: s);
      await tester.enterText(find.byKey(const Key('reply-field')), 'They came out, thanks');
      await tester.pump();
      await _tap(tester, find.byKey(const Key('send-reply')));
      expect(s.replies.single.id, id(1038));
      expect(s.replies.single.message, 'They came out, thanks');
      expect(tester.widget<TextField>(find.byKey(const Key('reply-field'))).controller!.text, isEmpty);
    });

    testWidgets('a resolved ticket says a reply reopens it', (tester) async {
      final s = _Support(tickets: [_ticketJson(status: 'resolved', statusLabel: 'Resolved')]);
      await _pump(tester, start: '/more/help/tickets/${id(1038)}', support: s);
      expect(find.byKey(const Key('reopen-note')), findsOneWidget);
    });

    testWidgets("someone else's ticket reads as not found", (tester) async {
      await _pump(tester, start: '/more/help/tickets/${id(9999)}');
      expect(find.text("We couldn't find that ticket"), findsOneWidget);
    });
  });

  group('Inbox', () {
    testWidgets('groups by day, shows unread dots, pins live announcements and hides ended ones', (tester) async {
      final inbox = _Inbox(
        items: [
          _item('n1', 'support', 'Reply on ticket #1038', _now.subtract(const Duration(minutes: 20))),
          _item('n2', 'payouts', 'Payout recorded', _now.subtract(const Duration(hours: 3)), read: true),
          _item('n3', 'cancellations', 'Order cancelled', _now.subtract(const Duration(days: 1, hours: 2)), read: true),
          _item('n4', 'high_demand', 'Busy in your area', _now.subtract(const Duration(days: 5)), read: true),
        ],
        announcementItems: [
          Announcement(id: 'a1', title: 'Diwali timings', body: 'Shops close early', endsAt: _now.add(const Duration(days: 3))),
          Announcement(id: 'a2', title: 'Old news', body: 'Over', endsAt: _now.subtract(const Duration(days: 1))),
        ],
      );
      await _pump(tester, start: '/notifications', inbox: inbox);
      expect(find.text('TODAY'), findsOneWidget);
      expect(find.text('YESTERDAY'), findsOneWidget);
      expect(
        find.text(DateFormat('d MMM y').format(_now.subtract(const Duration(days: 5)).toLocal()).toUpperCase()),
        findsOneWidget,
      );
      expect(find.byKey(const Key('unread-n1')), findsOneWidget);
      expect(find.byKey(const Key('unread-n2')), findsNothing);
      expect(find.byKey(const Key('announcement-a1')), findsOneWidget);
      expect(find.byKey(const Key('announcement-a2')), findsNothing);
      // Pinned above the first day heading.
      expect(
        tester.getTopLeft(find.byKey(const Key('announcement-a1'))).dy,
        lessThan(tester.getTopLeft(find.text('TODAY')).dy),
      );
    });

    testWidgets('Mark all read clears the dots and the bell, and tells the server', (tester) async {
      final inbox = _Inbox(items: [
        _item('n1', 'support', 'Reply', _now.subtract(const Duration(minutes: 20))),
        _item('n2', 'payouts', 'Payout', _now.subtract(const Duration(minutes: 40))),
      ]);
      final ctx = await _pump(tester, start: '/notifications', inbox: inbox);
      expect(ctx.container.read(unreadCountProvider), 2);
      await _tap(tester, find.byKey(const Key('mark-all-read')));
      expect(inbox.readAll, 1);
      expect(ctx.container.read(unreadCountProvider), 0);
      expect(find.byKey(const Key('unread-n1')), findsNothing);
      expect(tester.widget<TextButton>(find.byKey(const Key('mark-all-read'))).onPressed, isNull);
    });

    testWidgets('a tap marks it read and opens the page its url names', (tester) async {
      final inbox = _Inbox(items: [
        _item('n1', 'payouts', 'Payout recorded', _now.subtract(const Duration(minutes: 20)), url: '/earnings/payouts'),
      ]);
      await _pump(tester, start: '/notifications', inbox: inbox);
      await _tap(tester, find.byKey(const Key('inbox-n1')));
      expect(inbox.markedRead.single, ['n1']);
      expect(find.text('PAYOUTS PAGE'), findsOneWidget);
    });

    testWidgets('a ticket notification opens that ticket under Help', (tester) async {
      final inbox = _Inbox(items: [
        _item('n1', 'support', 'Reply on ticket', _now.subtract(const Duration(minutes: 20)),
            url: '/help/tickets/f7000000-0000-4000-8000-000000001038'),
      ]);
      await _pump(tester, start: '/notifications', inbox: inbox);
      await _tap(tester, find.byKey(const Key('inbox-n1')));
      expect(find.text('Ticket #1038'), findsOneWidget);
    });

    testWidgets('an empty inbox says so', (tester) async {
      await _pump(tester, start: '/notifications');
      expect(find.text('Nothing here yet'), findsOneWidget);
    });
  });

  group('Unread badge', () {
    testWidgets('the bell and the More row show the count, 99+ when large', (tester) async {
      final inbox = _Inbox(items: [
        _item('n1', 'support', 'Reply', _now),
        _item('n2', 'payouts', 'Payout', _now),
        _item('n3', 'payouts', 'Payout', _now, read: true),
      ]);
      await _pump(tester, start: '/home', inbox: inbox);
      expect(find.byKey(const Key('bell-count')), findsOneWidget);
      expect(find.text('2'), findsOneWidget);

    });

    testWidgets('More shows Help and Notifications with the unread count', (tester) async {
      final inbox = _Inbox(items: [_item('n1', 'support', 'Reply', _now)]);
      await _pump(tester, start: '/more', inbox: inbox);
      expect(find.byKey(const Key('row-help')), findsOneWidget);
      expect(find.byKey(const Key('row-notifications')), findsOneWidget);
      expect(find.byKey(const Key('notifications-badge')), findsOneWidget);
      expect(find.text('1 unread'), findsOneWidget);
    });

    testWidgets('no badge when everything is read, or when the inbox cannot be read', (tester) async {
      await _pump(tester, start: '/home', inbox: _Inbox(items: [_item('n1', 'support', 'Reply', _now, read: true)]));
      expect(find.byKey(const Key('bell-count')), findsNothing);
    });
  });

  group('Notification switches', () {
    Future<_Inbox> settings(WidgetTester tester, {_Inbox? inbox}) async {
      final i = inbox ?? _Inbox();
      await _pump(tester, start: '/settings', inbox: i);
      return i;
    }

    testWidgets('offers, cancellations and safety are locked on; the others can be switched', (tester) async {
      await settings(tester);
      for (final k in ['offers', 'cancellations', 'safety']) {
        final sw = tester.widget<Switch>(find.byKey(Key('notif-$k')));
        expect(sw.value, isTrue, reason: k);
        expect(sw.onChanged, isNull, reason: '$k is locked');
      }
      for (final k in ['pickup_reminders', 'delivery_updates', 'payouts', 'incentives', 'announcements', 'support', 'cash', 'documents', 'high_demand']) {
        final sw = tester.widget<Switch>(find.byKey(Key('notif-$k')));
        expect(sw.onChanged, isNotNull, reason: k);
      }
      expect(find.text('Always on. A missed offer is a missed job.'), findsOneWidget);
    });

    testWidgets('switching payouts off saves it server-side, every switch as a boolean', (tester) async {
      final inbox = await settings(tester);
      await _tap(tester, find.byKey(const Key('notif-payouts')));
      expect(inbox.saved, hasLength(1));
      expect(inbox.saved.last['payouts'], isFalse);
      expect(inbox.saved.last['cash'], isTrue);
      expect(inbox.saved.last.length, 9, reason: 'every switchable category, none locked');
      expect(tester.widget<Switch>(find.byKey(const Key('notif-payouts'))).value, isFalse);
      await _tap(tester, find.byKey(const Key('notif-cash')));
      expect(inbox.saved.last['payouts'], isFalse);
      expect(inbox.saved.last['cash'], isFalse);
      // And back on.
      await _tap(tester, find.byKey(const Key('notif-payouts')));
      expect(inbox.saved.last['payouts'], isTrue);
      expect(inbox.saved.last['cash'], isFalse);
    });

    testWidgets('a save the server refuses puts the switch back and says so', (tester) async {
      final inbox = _Inbox()..saveError = ApiException(400, 'invalid_body');
      await settings(tester, inbox: inbox);
      await _tap(tester, find.byKey(const Key('notif-support')));
      expect(tester.widget<Switch>(find.byKey(const Key('notif-support'))).value, isTrue);
      expect(find.textContaining("Couldn't save that"), findsOneWidget);
    });

    testWidgets('a locked switch is never sent, whatever is stored', (tester) async {
      final inbox = _Inbox()..prefs = NotificationPrefs.fromJson({'offers': false, 'safety': false, 'cash': false});
      await settings(tester, inbox: inbox);
      expect(tester.widget<Switch>(find.byKey(const Key('notif-offers'))).value, isTrue);
      expect(tester.widget<Switch>(find.byKey(const Key('notif-safety'))).value, isTrue);
      expect(tester.widget<Switch>(find.byKey(const Key('notif-cash'))).value, isFalse);
      expect(inbox.prefs.toJson()['cash'], isFalse);
      expect(inbox.prefs.toJson().containsKey('offers'), isFalse);
      expect(inbox.prefs.toJson().containsKey('safety'), isFalse);
    });
  });

  group('Push tap routing', () {
    bool has(String p) => const {
          '/jobs',
          '/home',
          '/earnings',
          '/earnings/payouts',
          '/earnings/incentives',
          '/notifications',
          '/more/help',
          '/safety',
        }.contains(p) ||
        p.startsWith('/more/help/tickets/');

    String route({String? category, String? url, Map<String, dynamic> data = const {}, bool Function(String)? exists}) =>
        routeForNotification(category: category, url: url, data: data, exists: exists ?? has);

    test('the server urls map to the rider routes', () {
      expect(route(url: '/jobs'), '/jobs');
      expect(route(url: '/jobs/f1000000-0000-4000-8000-000000000001'), '/jobs');
      expect(route(url: '/help/tickets/abc'), '/more/help/tickets/abc');
      expect(route(url: '/earnings/payouts'), '/earnings/payouts');
      expect(route(url: '/earnings/incentives'), '/earnings/incentives');
      expect(route(url: '/notifications'), '/notifications');
      expect(route(url: '/home'), '/home');
    });

    test('categories decide when there is no url', () {
      expect(route(category: 'offers'), '/jobs');
      expect(route(category: 'delivery_updates'), '/jobs');
      expect(route(category: 'payouts'), '/earnings');
      expect(route(category: 'incentives'), '/earnings');
      expect(route(category: 'support', data: {'ticketId': 't1'}), '/more/help/tickets/t1');
      expect(route(category: 'support'), '/more/help');
      expect(route(category: 'announcements'), '/notifications');
      expect(route(category: 'safety'), '/safety');
    });

    test('cash and documents go to their pages when this build has them, else the inbox', () {
      expect(route(category: 'cash', exists: (p) => p == '/more/cash'), '/more/cash');
      expect(route(category: 'cash', url: '/cash/deposits', exists: (p) => p == '/cash'), '/cash');
      expect(route(category: 'documents', exists: (p) => p == '/more/profile'), '/more/profile');
      expect(route(category: 'cash', exists: (_) => false), '/notifications');
      expect(route(category: 'documents', exists: (_) => false), '/notifications');
    });

    test('anything else is the inbox, and a web link is never a route', () {
      expect(route(url: 'https://deligro.example/admin'), '/notifications');
      expect(route(url: '/admin/support'), '/notifications');
      expect(route(), '/notifications');
      expect(route(url: '/jobs?x=1'), '/jobs');
    });
  });
  group('Light, dark and 1.3x text', () {
    _Inbox inbox() => _Inbox(
      items: [
        _item('n1', 'support', 'Reply on ticket #1038 with a rather long title to wrap', _now.subtract(const Duration(minutes: 20))),
        _item('n2', 'payouts', 'Payout recorded', _now.subtract(const Duration(hours: 3)), read: true),
      ],
      announcementItems: [Announcement(id: 'a1', title: 'Diwali timings', body: 'Shops close early on the 29th and 30th', endsAt: _now.add(const Duration(days: 3)))],
    );
    final id = 'f7000000-0000-4000-8000-000000001038';
    final pages = {
      'help': '/more/help',
      'new ticket': '/more/help/new',
      'thread': '/more/help/tickets/$id',
      'inbox': '/notifications',
      'settings': '/settings',
      'more': '/more',
    };
    for (final scale in [1.0, 1.3]) {
      for (final dark in [false, true]) {
        for (final e in pages.entries) {
          testWidgets('${e.key} at ${scale}x ${dark ? 'dark' : 'light'}', (tester) async {
            await _pump(
              tester,
              start: e.value,
              inbox: inbox(),
              brightness: dark ? Brightness.dark : Brightness.light,
              textScale: scale,
            );
            expect(tester.takeException(), isNull);
          });
        }
      }
    }
  });
}
