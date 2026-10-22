// Phase 7 fix round: photo types from bytes, saved data that belongs to one
// rider, the numbers kept for a first offline SOS, signed photos kept out of
// the disk cache, a push tapped before the gate, switches sent as booleans,
// the order picker, and finished-order push routes.
import 'dart:convert';
import 'dart:io';

import 'package:deligro_rider/core/active_cache.dart';
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/image_type.dart';
import 'package:deligro_rider/core/push.dart';
import 'package:deligro_rider/core/push_routes.dart';
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/data/notifications_repository.dart';
import 'package:deligro_rider/data/safety_repository.dart';
import 'package:deligro_rider/data/support_repository.dart';
import 'package:deligro_rider/features/help/attachments.dart';
import 'package:deligro_rider/features/help/signed_photo.dart';
import 'package:deligro_rider/models/inbox.dart';
import 'package:deligro_rider/models/jobs.dart';
import 'package:deligro_rider/models/support.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/state/safety.dart';
import 'package:deligro_rider/state/support.dart';
import 'package:deligro_rider/state/user_data.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'support/photo_files.dart';

class _Uid extends Notifier<String?> {
  @override
  String? build() => 'rider-a';

  void set(String? v) => state = v;
}

final _uidProvider = NotifierProvider<_Uid, String?>(_Uid.new);

class _Notifs implements NotificationsRepository {
  NotificationPrefs? server;
  Object? loadError;
  final saved = <Map<String, bool>>[];

  @override
  Future<InboxPage> inbox({String? before, int limit = 30}) async => InboxPage.empty;

  @override
  Future<void> markRead(List<String> ids) async {}

  @override
  Future<void> markAllRead() async {}

  @override
  Future<List<Announcement>> announcements() async => const [];

  @override
  Future<NotificationPrefs?> loadPrefs() async {
    final e = loadError;
    if (e != null) throw e;
    return server;
  }

  @override
  Future<void> savePrefs(NotificationPrefs prefs) async => saved.add(prefs.toJson());
}

class _Safety implements SafetyRepository {
  EmergencyContact? contact;
  Object? error;
  var calls = 0;

  @override
  Future<SosAck> sos({
    required SosKind kind,
    double? lat,
    double? lng,
    String? note,
    String? orderId,
    List<File> photos = const [],
  }) => throw UnimplementedError();

  @override
  Future<EmergencyContact?> emergencyContact() async {
    calls++;
    final e = error;
    if (e != null) throw e;
    return contact;
  }
}

class _Support implements SupportRepository {
  SupportContact contact = const SupportContact(phone: '+91 98765 43210');
  Object? error;
  List<RecentOrder> orders = const [];

  @override
  Future<SupportOverview> overview() async {
    final e = error;
    if (e != null) throw e;
    return SupportOverview(tickets: const [], contact: contact, categories: const []);
  }

  @override
  Future<TicketThread> thread(String id) => throw UnimplementedError();

  @override
  Future<CreatedTicket> create({
    required String category,
    String? subject,
    required String message,
    String? orderId,
    List<File> photos = const [],
    double? lat,
    double? lng,
  }) => throw UnimplementedError();

  @override
  Future<void> reply(String id, String message, {List<File> photos = const []}) => throw UnimplementedError();

  @override
  Future<List<RecentOrder>> recentOrders() async => orders;
}

Future<ProviderContainer> _container(
  SharedPreferences prefs, {
  _Notifs? notifs,
  _Safety? safety,
  _Support? support,
}) async {
  final c = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      userIdProvider.overrideWith((ref) => ref.watch(_uidProvider)),
      notificationsRepoProvider.overrideWithValue(notifs ?? _Notifs()),
      safetyRepoProvider.overrideWithValue(safety ?? _Safety()),
      supportRepoProvider.overrideWithValue(support ?? _Support()),
    ],
  );
  addTearDown(c.dispose);
  return c;
}

Future<void> _tick() => Future<void>.delayed(const Duration(milliseconds: 20));

SupabaseClient _supabase() {
  final c = SupabaseClient(
    'http://localhost:1',
    'test-key',
    authOptions: const AuthClientOptions(autoRefreshToken: false),
  );
  addTearDown(() => c.dispose());
  return c;
}

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('M1: a photo is what its bytes say', () {
    test('sniffing', () {
      expect(sniffImageBytes([0xFF, 0xD8, 0xFF, 0xE0]), PhotoType.jpeg);
      expect(sniffImageBytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), PhotoType.png);
      expect(sniffImageBytes('%PDF-1.4'.codeUnits), isNull);
      expect(sniffImageBytes([0x89, 0x50, 0x4E, 0x47]), isNull, reason: 'a PNG header is eight bytes');
      expect(sniffImageBytes(const []), isNull);
    });

    test('a PNG called .jpg passes as a PNG; a PDF called .jpg is refused', () {
      final png = testPhoto('looks-like.jpg', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]);
      expect(sniffImageFile(png), PhotoType.png);
      expect(photoProblem(png), isNull);
      final pdf = testPhoto('liar.jpg', bytes: '%PDF-1.4'.codeUnits);
      expect(photoProblem(pdf), 'Only JPEG or PNG photos can be sent.');
      expect(photoProblem(File('${Directory.systemTemp.path}/p7a_missing.jpg')), isNotNull);
    });

    test('the upload carries the type of the bytes, and refuses a non-photo before sending', () async {
      final seen = <http.BaseRequest>[];
      final bodies = <String>[];
      final client = MockClient((req) async {
        seen.add(req);
        bodies.add(latin1.decode(req.bodyBytes));
        return http.Response('{"ok":true}', 200, headers: {'content-type': 'application/json'});
      });
      final api = ApiClient(_supabase().auth, client: client);
      final png = testPhoto('really-png.jpg', bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2]);
      await api.postMultipart('/api/rider/support/tickets', {'category': 'other', 'message': 'x'}, 'photos', [png]);
      expect(seen, hasLength(1));
      expect(bodies.single.toLowerCase(), contains('content-type: image/png'));

      final pdf = testPhoto('fake.png', bytes: '%PDF-1.4'.codeUnits);
      await expectLater(
        api.postMultipart('/api/rider/support/tickets', {'category': 'other'}, 'photos', [pdf]),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'bad_photo_type')),
      );
      expect(seen, hasLength(1), reason: 'nothing was sent for the refused photo');
    });
  });

  group("saved data belongs to one rider", () {
    test('purgeOtherUsers keeps only the signed-in rider\'s items, and clears all on sign-out', () async {
      SharedPreferences.setMockInitialValues({
        'emergency_contact_v1': '{"phone":"1"}', // an old unkeyed copy
        'emergency_contact_v1:rider-a': '{"phone":"a"}',
        'emergency_contact_v1:rider-b': '{"phone":"b"}',
        'notification_prefs_v1:rider-a': '{"cash":false}',
        'notification_prefs_v1:rider-b': '{"cash":false}',
        'nav_app': 'other',
      });
      final prefs = await SharedPreferences.getInstance();
      await purgeOtherUsers(prefs, 'rider-b');
      expect(prefs.getKeys().toSet(), {'emergency_contact_v1:rider-b', 'notification_prefs_v1:rider-b', 'nav_app'});
      await purgeOtherUsers(prefs, null);
      expect(prefs.getKeys().toSet(), {'nav_app'});
    });

    test('rider B never sees rider A\'s switches, even when the server says nothing', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final notifs = _Notifs();
      final c = await _container(prefs, notifs: notifs);
      c.read(userDataGuardProvider);
      expect(c.read(notificationPrefsProvider).isOn('payouts'), isTrue);
      expect(await c.read(notificationPrefsProvider.notifier).set('payouts', false), isTrue);
      expect(c.read(notificationPrefsProvider).isOn('payouts'), isFalse);

      // Rider A signs out, rider B signs in; the server returns null for B.
      c.read(_uidProvider.notifier).set(null);
      await _tick();
      c.read(_uidProvider.notifier).set('rider-b');
      await _tick();
      expect(c.read(notificationPrefsProvider).isOn('payouts'), isTrue, reason: 'B starts from their own');
      expect(prefs.getKeys().any((k) => k.endsWith('rider-a')), isFalse, reason: 'A\'s copy is deleted');

      // And back: A\'s switches are not there to come back to.
      c.read(_uidProvider.notifier).set('rider-a');
      await _tick();
      expect(c.read(notificationPrefsProvider).isOn('payouts'), isTrue);
    });

    test('a save for A that finishes after B signed in does not change B\'s screen', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final c = await _container(prefs);
      c.read(notificationPrefsProvider);
      await _tick();
      await c.read(notificationPrefsProvider.notifier).set('cash', false);
      c.read(_uidProvider.notifier).set('rider-b');
      await _tick();
      expect(c.read(notificationPrefsProvider).isOn('cash'), isTrue);
    });

    test('the server\'s switches win when it answers, and are kept under the user', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final notifs = _Notifs()..server = NotificationPrefs.fromJson({'cash': false, 'documents': true});
      final c = await _container(prefs, notifs: notifs);
      c.read(notificationPrefsProvider);
      await _tick();
      expect(c.read(notificationPrefsProvider).isOn('cash'), isFalse);
      expect(prefs.getString('notification_prefs_v1:rider-a'), contains('"cash":false'));
    });

    test('the emergency contact is per rider: B gets none of A\'s, offline or not', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final safety = _Safety()..contact = const EmergencyContact(name: 'Sunita', phone: '+919123456780');
      final c = await _container(prefs, safety: safety);
      expect((await c.read(emergencyContactProvider.future))?.name, 'Sunita');
      expect(prefs.getString('emergency_contact_v1:rider-a'), contains('Sunita'));

      c.read(_uidProvider.notifier).set('rider-b');
      safety.error = ApiException(0, 'network');
      await _tick();
      expect(await c.read(emergencyContactProvider.future), isNull);
    });

    test('a contact the server no longer has is forgotten', () async {
      SharedPreferences.setMockInitialValues({
        'emergency_contact_v1:rider-a': '{"name":"Old","phone":"+911111111111"}',
      });
      final prefs = await SharedPreferences.getInstance();
      final safety = _Safety()..contact = null;
      final c = await _container(prefs, safety: safety);
      expect((await c.read(emergencyContactProvider.future))?.name, 'Old', reason: 'the copy answers first');
      await _tick();
      expect(prefs.getString('emergency_contact_v1:rider-a'), isNull);
    });
  });

  group('numbers kept for a first SOS with no signal', () {
    test('both are fetched and kept, the contact under the rider', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      await cacheOfflineEssentials(
        support: _Support(),
        safety: _Safety()..contact = const EmergencyContact(name: 'Sunita', phone: '+919123456780'),
        prefs: prefs,
        uid: 'rider-a',
      );
      expect(prefs.getString('support_contact_v1'), contains('98765 43210'));
      expect(prefs.getString('emergency_contact_v1:rider-a'), contains('Sunita'));
    });

    test('a failure is silent and leaves what was kept', () async {
      SharedPreferences.setMockInitialValues({
        'support_contact_v1': '{"phone":"+91 11111 11111","whatsapp":null}',
        'emergency_contact_v1:rider-a': '{"name":"Kept","phone":"+912222222222"}',
      });
      final prefs = await SharedPreferences.getInstance();
      await cacheOfflineEssentials(
        support: _Support()..error = ApiException(0, 'network'),
        safety: _Safety()..error = ApiException(0, 'network'),
        prefs: prefs,
        uid: 'rider-a',
      );
      expect(prefs.getString('support_contact_v1'), contains('11111 11111'));
      expect(prefs.getString('emergency_contact_v1:rider-a'), contains('Kept'));
    });

    test('answers that arrive after the signed-in user changed are dropped', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      await cacheOfflineEssentials(
        support: _Support(),
        safety: _Safety()..contact = const EmergencyContact(name: 'Sunita', phone: '+919123456780'),
        prefs: prefs,
        uid: 'rider-a',
        currentUid: () => 'rider-b', // someone else is signed in by the time they come back
      );
      expect(prefs.getKeys().where((k) => k.startsWith('emergency_contact_v1')), isEmpty);
      expect(prefs.getString('support_contact_v1'), isNull);
    });

    test('a first SOS made offline still finds both numbers', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      await cacheOfflineEssentials(
        support: _Support(),
        safety: _Safety()..contact = const EmergencyContact(name: 'Sunita', phone: '+919123456780'),
        prefs: prefs,
        uid: 'rider-a',
      );
      // Later, with no signal and nothing else visited:
      final c = await _container(prefs, safety: _Safety()..error = ApiException(0, 'network'), support: _Support()..error = ApiException(0, 'network'));
      expect((await c.read(emergencyContactProvider.future))?.phone, '+919123456780');
      expect((await c.read(supportContactProvider.future)).phone, '+91 98765 43210');
    });
  });

  group('signed photos stay out of the disk cache', () {
    testWidgets('SignedPhoto draws with Image.network and never a cached network image', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: buildTheme(Brightness.light),
          home: const Scaffold(body: SignedPhoto(url: 'https://example.invalid/signed?token=abc')),
        ),
      );
      final image = tester.widget<Image>(find.byType(Image));
      final provider = image.image is ResizeImage ? (image.image as ResizeImage).imageProvider : image.image;
      expect(provider, isA<NetworkImage>());
      expect(find.byWidgetPredicate((w) => w.runtimeType.toString().contains('CachedNetworkImage')), findsNothing);
    });

    test('no support or safety screen uses the cached network image', () {
      final files = [
        ...Directory('lib/features/help').listSync().whereType<File>(),
        ...Directory('lib/features/safety').listSync().whereType<File>(),
      ];
      final offenders = [
        for (final f in files)
          if (RegExp(r'CachedNetworkImage|NetImage\(').hasMatch(f.readAsStringSync())) f.path,
      ];
      expect(offenders, isEmpty);
    });
  });

  group('the saved delivery belongs to one rider', () {
    RiderActive active() {
      final board = FixtureData.board('on_the_way', now: DateTime.utc(2026, 10, 22, 10));
      return RiderActive.fromJson(board['active'] as Map<String, dynamic>);
    }

    test('rider B is never offered the previous rider delivery', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      var user = 'rider-a';
      final cache = ActiveDeliveryCache(prefs, ownerUid: () => user);
      await cache.save(active());
      expect(cache.load(), isNotNull, reason: 'A sees their own');
      user = 'rider-b';
      expect(cache.load(), isNull);
      await _tick();
      expect(prefs.getString(ActiveDeliveryCache.key), isNull, reason: 'and it is let go');
      expect(prefs.getString(ActiveDeliveryCache.ownerKey), isNull);
    });

    test('a copy with no owner (an older build, or no session to ask) is still read', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      await ActiveDeliveryCache(prefs).save(active());
      expect(ActiveDeliveryCache(prefs, ownerUid: () => 'rider-a').load(), isNotNull);
      expect(ActiveDeliveryCache(prefs).load(), isNotNull);
    });

    test('clear forgets the owner too', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final cache = ActiveDeliveryCache(prefs, ownerUid: () => 'rider-a');
      await cache.save(active());
      await cache.clear();
      expect(prefs.getKeys().where((k) => k.startsWith('active_delivery')), isEmpty);
    });

    test('the picker lists no order of a previous rider', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final c = await _container(prefs);
      await c.read(activeCacheProvider).save(active());
      expect((await c.read(recentOrdersProvider.future)).first.orderId, active().orderId);
      c.read(_uidProvider.notifier).set('rider-b');
      await _tick();
      expect(await c.read(recentOrdersProvider.future), isEmpty);
    });
  });

  group('M2: switches are sent as explicit booleans', () {
    test('toJson lists every switchable category, never a locked one', () {
      final json = const NotificationPrefs({'payouts'}).toJson();
      expect(json['payouts'], isFalse);
      expect(json['cash'], isTrue);
      expect(json.keys.toSet(), {
        'pickup_reminders',
        'delivery_updates',
        'payouts',
        'incentives',
        'announcements',
        'support',
        'cash',
        'documents',
        'high_demand',
      });
      expect(json.containsKey('offers'), isFalse);
      expect(json.containsKey('safety'), isFalse);
    });

    test('the PATCH carries {notificationPrefs: {category: bool}}', () async {
      http.Request? seen;
      final client = MockClient((req) async {
        seen = req;
        return http.Response('{"ok":true}', 200, headers: {'content-type': 'application/json'});
      });
      final repo = ApiNotificationsRepository(ApiClient(_supabase().auth, client: client));
      await repo.savePrefs(const NotificationPrefs({'cash'}));
      expect(seen!.method, 'PATCH');
      expect(seen!.url.path, '/api/rider/profile');
      final body = jsonDecode(seen!.body) as Map<String, dynamic>;
      final prefs = body['notificationPrefs'] as Map<String, dynamic>;
      expect(prefs['cash'], false);
      expect(prefs['payouts'], true);
      expect(prefs.length, 9);
    });

    test('GET reads category -> bool for every category; a missing key is on', () {
      final p = NotificationPrefs.fromJson({'offers': false, 'cash': false, 'payouts': true});
      expect(p.isOn('cash'), isFalse);
      expect(p.isOn('payouts'), isTrue);
      expect(p.isOn('offers'), isTrue, reason: 'locked');
      expect(p.isOn('documents'), isTrue);
    });
  });

  group('a push tapped before the gate', () {
    GoRouter routerAt(String start) => GoRouter(
          initialLocation: start,
          routes: [
            for (final p in ['/gate', '/login', '/home', '/jobs', '/more/help', '/notifications'])
              GoRoute(path: p, builder: (_, _) => const SizedBox()),
          ],
        );

    test('held while the gate screen shows, for the user who got it', () {
      final pending = PendingPush();
      final router = routerAt('/gate');
      addTearDown(router.dispose);
      openPush(router, {'category': 'support', 'url': '/help'}, pending: pending, uid: 'rider-a');
      expect(pending.isHeld, isTrue);
      expect(router.routeInformationProvider.value.uri.path, '/gate', reason: 'not sent to a gate that would lose it');
      expect(pending.take('rider-a'), '/more/help');
      expect(pending.isHeld, isFalse);
    });

    test('opened at once when the rider is already through', () {
      final pending = PendingPush();
      final router = routerAt('/home');
      addTearDown(router.dispose);
      openPush(router, {'category': 'offers', 'url': '/jobs'}, pending: pending, uid: 'rider-a');
      expect(pending.isHeld, isFalse);
      expect(router.routeInformationProvider.value.uri.path, '/jobs');
    });

    test('nothing is held for nobody (signed out)', () {
      final pending = PendingPush()..hold('/jobs', 'rider-a');
      final router = routerAt('/login');
      addTearDown(router.dispose);
      openPush(router, {'url': '/jobs'}, pending: pending, uid: null);
      expect(pending.isHeld, isFalse);
    });

    test('another user signing in does not get it', () {
      final pending = PendingPush()..hold('/more/help', 'rider-a');
      expect(pending.take('rider-b'), isNull);
      expect(pending.isHeld, isFalse);
    });
  });

  group('M3: the order picker lists the active delivery first', () {
    test('active, then history without a repeat', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final board = FixtureData.board('on_the_way', now: DateTime.utc(2026, 10, 22, 10));
      final active = RiderActive.fromJson(board['active'] as Map<String, dynamic>);
      final support = _Support()
        ..orders = [
          const RecentOrder(orderId: 'h1', code: '#H1', shop: 'Old shop'),
          RecentOrder(orderId: active.orderId, code: active.code, shop: 'dup'),
        ];
      final c = await _container(prefs, support: support);
      await c.read(activeCacheProvider).save(active);
      final list = await c.read(recentOrdersProvider.future);
      expect(list.first.orderId, active.orderId);
      expect(list.first.code, active.code);
      expect(list.map((o) => o.orderId), [active.orderId, 'h1']);
    });

    test('no active delivery: just history', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final support = _Support()..orders = [const RecentOrder(orderId: 'h1', code: '#H1')];
      final c = await _container(prefs, support: support);
      expect((await c.read(recentOrdersProvider.future)).map((o) => o.orderId), ['h1']);
    });
  });

  group('M7: a push about a finished order', () {
    bool has(String p) => p.startsWith('/history/order/') || p == '/jobs' || p == '/notifications';
    String route(Map<String, dynamic> data, {String? url, String? category, bool Function(String)? exists}) =>
        routeForNotification(category: category, url: url, data: data, exists: exists ?? has);

    test('says finished and names the order: the history page', () {
      expect(route({'orderId': 'o1', 'finished': true}, url: '/jobs/o1'), '/history/order/o1');
      expect(route({'orderId': 'o1', 'outcome': 'delivered'}, url: '/jobs/o1'), '/history/order/o1');
      expect(route({'orderId': 'o1', 'outcome': 'cancelled'}, category: 'cancellations'), '/history/order/o1');
    });

    test('cannot tell, or still active: Jobs', () {
      expect(route({'orderId': 'o1'}, url: '/jobs/o1'), '/jobs');
      expect(route({'orderId': 'o1', 'outcome': 'on_the_way'}, url: '/jobs/o1'), '/jobs');
      expect(route({'finished': true}, url: '/jobs'), '/jobs', reason: 'no order named');
    });

    test('a build without the history page goes to Jobs', () {
      expect(route({'orderId': 'o1', 'finished': true}, url: '/jobs/o1', exists: (p) => p == '/jobs'), '/jobs');
    });
  });
}
