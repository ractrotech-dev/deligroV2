// Safety and SOS: the SOS sheet (Call 112, Alert Deligro, emergency contact,
// support), an alert that cannot reach the server and keeps trying, the Safety
// screen and the report forms, and the §15 wording. No network and no phone
// calls: the safety repository is a fake and the URL launcher a recorder.
import 'dart:async';
import 'dart:io';

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/location_service.dart';
import 'package:deligro_rider/core/navigation_launcher.dart';
import 'package:deligro_rider/core/sos_queue.dart';
import 'package:deligro_rider/data/safety_repository.dart';
import 'package:deligro_rider/features/help/attachments.dart';
import 'package:deligro_rider/features/safety/safety_screen.dart';
import 'package:deligro_rider/features/safety/sos_sheet.dart';
import 'package:deligro_rider/features/safety/stale_sos_banner.dart';
import 'package:deligro_rider/models/support.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart' show userIdProvider;
import 'package:deligro_rider/state/safety.dart';
import 'package:deligro_rider/state/support.dart';
import 'package:deligro_rider/data/support_repository.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/photo_files.dart';

class _Sent {
  _Sent(this.kind, this.lat, this.lng, this.note, this.photos, this.orderId);
  final SosKind kind;
  final double? lat;
  final double? lng;
  final String? note;
  final int photos;
  final String? orderId;
}

class _Safety implements SafetyRepository {
  _Safety({this.contact = const EmergencyContact(name: 'Sunita', phone: '+919123456780', relation: 'Wife')});

  EmergencyContact? contact;
  Object? error;
  final sent = <_Sent>[];
  final attempts = <_Sent>[];

  @override
  Future<SosAck> sos({
    required SosKind kind,
    double? lat,
    double? lng,
    String? note,
    String? orderId,
    List<File> photos = const [],
  }) async {
    final s = _Sent(kind, lat, lng, note, photos.length, orderId);
    attempts.add(s);
    final e = error;
    if (e != null) throw e;
    sent.add(s);
    return SosAck(ticketId: 't1', number: 1060, deduped: sent.length > 1);
  }

  @override
  Future<EmergencyContact?> emergencyContact() async => contact;
}

class _Support implements SupportRepository {
  @override
  Future<SupportOverview> overview() async => SupportOverview.fromJson({
        'tickets': const [],
        'contact': {'phone': '+91 98765 43210', 'whatsapp': null},
        'categories': const [],
      });

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
  Future<List<RecentOrder>> recentOrders() async => const [];
}

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
  String start = '/host',
  _Safety? safety,
  Map<String, Object> prefs = const {},
  ({double lat, double lng})? fix = (lat: 21.7189, lng: 81.5301),
  ({double lat, double lng})? current,
  Duration fixAge = Duration.zero,
  String uid = 'rider-1',
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  List<File> Function(int)? gallery,
  Future<({double lat, double lng})?> Function()? currentFn,
}) async {
  tester.view.physicalSize = const Size(360 * 3, 760 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues(prefs);
  final opened = <Uri>[];
  final router = GoRouter(
    initialLocation: start,
    routes: [
      GoRoute(
        path: '/host',
        builder: (_, _) => const Scaffold(
          body: Center(child: Column(mainAxisSize: MainAxisSize.min, children: [StaleSosBanner(), SosButton()])),
        ),
      ),
      GoRoute(path: '/more/profile', builder: (_, _) => const Scaffold(body: Text('PROFILE PAGE'))),
      safetyRoute,
    ],
  );
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      safetyRepoProvider.overrideWithValue(safety ?? _Safety()),
      supportRepoProvider.overrideWithValue(_Support()),
      urlOpenerProvider.overrideWithValue((uri) async {
        opened.add(uri);
        return true;
      }),
      userIdProvider.overrideWithValue(uid),
      currentPositionProvider.overrideWithValue(currentFn ?? () async => current),
      galleryPickerProvider.overrideWithValue((limit) async => gallery?.call(limit) ?? const []),
    ],
  );
  addTearDown(container.dispose);
  if (fix != null) container.read(latestFixProvider.notifier).set((lat: fix.lat, lng: fix.lng, at: DateTime.now().subtract(fixAge)));
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
  await tester.pump(const Duration(milliseconds: 400));
  await _settle(tester, rounds: 2);
}

Future<void> _openSheet(WidgetTester tester) => _tap(tester, find.byKey(const Key('sos-button')));

String _allText(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((t) => t.data ?? t.textSpan?.toPlainText() ?? '')
    .join('\n');

/// What a claim that emergency services were reached looks like.
final _claim = RegExp(
  r'(emergency services|police|ambulance|fire (brigade|service)|authorities)[^.\n]{0,40}'
  r'(contacted|notified|alerted|called|informed|dispatched|on (the|their) way)'
  r'|(contacted|notified|informed|called)[^.\n]{0,25}(emergency services|police|ambulance|authorities)'
  r'|help is on (the|its) way',
  caseSensitive: false,
);

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('SosQueue', () {
    late SharedPreferences prefs;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
    });

    test('a confirmed alert is sent, once, and leaves nothing waiting', () async {
      final repo = _Safety();
      final q = SosQueue(repo, prefs, uid: () => 'u1');
      addTearDown(q.dispose);
      final s = await q.alert(lat: 21.7, lng: 81.5);
      expect(s.phase, SosPhase.sent);
      expect(s.ack!.ticketId, 't1');
      expect(repo.sent.single.kind, SosKind.alert);
      expect((repo.sent.single.lat, repo.sent.single.lng), (21.7, 81.5));
      expect(q.waiting, isEmpty);
    });

    test('no connection: queued, kept on the phone, never "sent"', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = SosQueue(repo, prefs, uid: () => 'u1', retryEvery: const Duration(hours: 1));
      addTearDown(q.dispose);
      final s = await q.alert(lat: 21.7, lng: 81.5);
      expect(s.phase, SosPhase.queued);
      expect(repo.sent, isEmpty);
      expect(q.waiting, hasLength(1));
      expect(prefs.getString(SosQueue.key), contains('21.7'));
    });

    test('every kind of failure to confirm stays queued: 5xx, 429, 401', () async {
      for (final status in [500, 503, 429, 401]) {
        final repo = _Safety()..error = ApiException(status, 'x');
        final q = SosQueue(repo, prefs, uid: () => 'u1', retryEvery: const Duration(hours: 1));
        addTearDown(q.dispose);
        expect((await q.alert()).phase, SosPhase.queued, reason: '$status');
      }
    });

    test('it retries on its beat and sends with the newest position', () {
      fakeAsync((async) {
        final repo = _Safety()..error = ApiException(0, 'network');
        var here = (lat: 21.0, lng: 81.0);
        final q = SosQueue(repo, prefs, uid: () => 'u1', retryEvery: const Duration(milliseconds: 40), position: () async => here);
        q.alert();
        async.flushMicrotasks();
        expect(q.current.phase, SosPhase.queued);
        repo.error = null;
        here = (lat: 21.5, lng: 81.5);
        async.elapse(const Duration(milliseconds: 40));
        expect(q.current.phase, SosPhase.sent);
        expect((repo.sent.single.lat, repo.sent.single.lng), (21.5, 81.5));
        expect(q.waiting, isEmpty);
        q.dispose();
      });
    });

    test('an alert saved before the app was closed is tried again by the next queue', () async {
      final down = _Safety()..error = ApiException(0, 'network');
      final first = SosQueue(down, prefs, uid: () => 'u1', retryEvery: const Duration(hours: 1));
      await first.alert(lat: 21.7, lng: 81.5, orderId: 'o1');
      first.dispose();

      final up = _Safety();
      final second = SosQueue(up, prefs, uid: () => 'u1', retryEvery: const Duration(hours: 1));
      addTearDown(second.dispose);
      expect(second.current.phase, SosPhase.queued);
      await second.flush();
      expect(second.current.phase, SosPhase.sent);
      expect(up.sent.single.orderId, 'o1');
      expect((up.sent.single.lat, up.sent.single.lng), (21.7, 81.5));
    });

    test('a refusal (400) is dropped, not retried for ever', () async {
      final repo = _Safety()..error = ApiException(400, 'invalid_kind');
      final q = SosQueue(repo, prefs, uid: () => 'u1', retryEvery: const Duration(milliseconds: 20));
      addTearDown(q.dispose);
      expect((await q.alert()).phase, SosPhase.refused);
      expect(q.waiting, isEmpty);
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(repo.attempts, hasLength(1));
    });

    test('a second tap while one waits replaces it, not adds to it', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = SosQueue(repo, prefs, uid: () => 'u1', retryEvery: const Duration(hours: 1));
      addTearDown(q.dispose);
      await q.alert(lat: 1, lng: 1);
      await q.alert(lat: 2, lng: 2);
      expect(q.waiting, hasLength(1));
      expect(q.waiting.single.lat, 2);
    });
  });

  group('SosQueue: owner, age, sign-in', () {
    late SharedPreferences prefs;
    var now = DateTime.utc(2026, 10, 22, 10);

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
      now = DateTime.utc(2026, 10, 22, 10);
    });

    SosQueue queue(_Safety repo, {String? Function()? uid, SosPosition? Function()? pos}) => SosQueue(
          repo,
          prefs,
          uid: uid ?? () => 'u1',
          retryEvery: const Duration(hours: 1),
          clock: () => now,
          position: pos == null ? null : () async => pos(),
        );

    test('an alert is stored with its owner', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = queue(repo);
      addTearDown(q.dispose);
      await q.alert(lat: 1, lng: 2);
      expect(q.waiting.single.uid, 'u1');
      expect(prefs.getString(SosQueue.key), contains('"uid":"u1"'));
    });

    test('a sign-out drops it, and it is never sent', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = queue(repo);
      addTearDown(q.dispose);
      await q.alert(lat: 1, lng: 2);
      repo.error = null;
      await q.userChanged(null);
      expect(q.waiting, isEmpty);
      expect(prefs.getString(SosQueue.key), '[]');
      await q.flush();
      expect(repo.sent, isEmpty);
    });

    test('another user signing in drops it: never sent under their session', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = queue(repo);
      addTearDown(q.dispose);
      await q.alert(lat: 1, lng: 2);
      repo.error = null;
      await q.userChanged('u2');
      expect(q.waiting, isEmpty);
      await q.flush();
      expect(repo.sent, isEmpty);
    });

    test('an alert left in storage by another user is dropped at start, not sent', () async {
      final down = _Safety()..error = ApiException(0, 'network');
      final first = SosQueue(down, prefs, uid: () => 'u1', retryEvery: const Duration(hours: 1), clock: () => now);
      await first.alert(lat: 1, lng: 2);
      first.dispose();
      final repo = _Safety();
      final second = SosQueue(repo, prefs, uid: () => 'u2', retryEvery: const Duration(hours: 1), clock: () => now);
      addTearDown(second.dispose);
      expect(second.waiting, isEmpty);
      await second.flush();
      expect(repo.attempts, isEmpty);
    });

    test('an alert with no owner (an old copy) is not one to send', () async {
      await prefs.setString(
        SosQueue.key,
        '[{"id":"x","lat":1,"lng":2,"queuedAt":"2026-10-22T10:00:00Z"}]',
      );
      final repo = _Safety();
      final q = queue(repo);
      addTearDown(q.dispose);
      await q.flush();
      expect(q.waiting, isEmpty);
      expect(repo.attempts, isEmpty);
    });

    test('over an hour old: not sent by itself, kept, and the rider is asked', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = queue(repo);
      addTearDown(q.dispose);
      await q.alert(lat: 1, lng: 2);
      expect(repo.attempts, hasLength(1));
      repo.error = null;
      now = now.add(const Duration(minutes: 61));
      await q.flush();
      expect(q.current.phase, SosPhase.stale);
      expect(repo.attempts, hasLength(1), reason: 'no automatic send of a stale alert');
      expect(q.waiting, hasLength(1));
    });

    test('Send now sends a stale alert (without its old position)', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = queue(repo);
      addTearDown(q.dispose);
      await q.alert(lat: 1, lng: 2);
      repo.error = null;
      now = now.add(const Duration(minutes: 90));
      await q.flush();
      await q.sendNow();
      expect(q.current.phase, SosPhase.sent);
      expect(repo.sent.single.lat, isNull, reason: 'a 90-minute-old position is not current');
    });

    test('Discard drops a stale alert', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = queue(repo);
      addTearDown(q.dispose);
      await q.alert(lat: 1, lng: 2);
      now = now.add(const Duration(minutes: 90));
      await q.flush();
      await q.discard();
      expect(q.current.phase, SosPhase.idle);
      expect(q.waiting, isEmpty);
      expect(prefs.getString(SosQueue.key), '[]');
    });

    test('a stale alert found at start waits for the rider', () async {
      final down = _Safety()..error = ApiException(0, 'network');
      final first = queue(down);
      await first.alert(lat: 1, lng: 2);
      first.dispose();
      now = now.add(const Duration(hours: 3));
      final repo = _Safety();
      final second = queue(repo);
      addTearDown(second.dispose);
      expect(second.current.phase, SosPhase.stale);
      await second.flush();
      expect(repo.attempts, isEmpty);
    });

    test('a 401 stops the retries until the same user signs in again', () async {
      final repo = _Safety()..error = ApiException(401, 'unauthenticated');
      final q = SosQueue(repo, prefs, uid: () => 'u1', retryEvery: const Duration(milliseconds: 20), clock: () => now);
      addTearDown(q.dispose);
      await q.alert(lat: 1, lng: 2);
      expect(q.current.phase, SosPhase.queued);
      expect(q.current.needsSignIn, isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 150));
      expect(repo.attempts, hasLength(1), reason: 'no retry after a 401');
      // Someone else signing in does not wake it (it is dropped); the same user does.
      repo.error = null;
      await q.userChanged('u1');
      expect(q.current.phase, SosPhase.sent);
      expect(repo.sent, hasLength(1));
    });

    test('the first try uses the own fresh position of the alert; only retries ask for a new reading', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      var asked = 0;
      final q = queue(repo, pos: () {
        asked++;
        return (lat: 5, lng: 6);
      });
      addTearDown(q.dispose);
      await q.alert(lat: 1, lng: 2);
      expect((repo.attempts.single.lat, repo.attempts.single.lng), (1, 2));
      expect(asked, 0, reason: 'no reading asked for on the first try');
      await q.flush(); // a retry
      expect(asked, 1);
      expect((repo.attempts.last.lat, repo.attempts.last.lng), (5, 6), reason: 'the reading taken then');
    });

    test('a retry does not resend an old position as current', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = queue(repo, pos: () => null);
      addTearDown(q.dispose);
      await q.alert(lat: 1, lng: 2);
      expect(repo.attempts.single.lat, 1, reason: 'pressed just now: still current');
      now = now.add(const Duration(minutes: 5));
      repo.error = null;
      await q.flush();
      expect(repo.sent.single.lat, isNull, reason: 'five minutes old: sent without a position');
    });
  });

  group('SosQueue: saved first, position waited for briefly', () {
    late SharedPreferences prefs;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
    });

    SosQueue slow(_Safety repo, Future<SosPosition?> Function() pos,
            {Duration wait = const Duration(seconds: 5), String? Function()? uid}) =>
        SosQueue(
          repo,
          prefs,
          uid: uid ?? () => 'u1',
          retryEvery: const Duration(hours: 1),
          positionWait: wait,
          position: pos,
        );

    test('the alert is on the phone and on screen before the position arrives', () async {
      final repo = _Safety();
      final gps = Completer<SosPosition?>();
      final q = slow(repo, () => gps.future);
      addTearDown(q.dispose);
      final done = q.alert();
      await Future<void>.delayed(const Duration(milliseconds: 40));
      expect(q.waiting, hasLength(1), reason: 'queued at once');
      expect(prefs.getString(SosQueue.key), contains('"uid":"u1"'), reason: 'written to the phone at once');
      expect(q.current.phase, SosPhase.sending);
      expect(repo.attempts, isEmpty, reason: 'still waiting for the position');
      gps.complete((lat: 7.0, lng: 8.0));
      await done;
      expect((repo.sent.single.lat, repo.sent.single.lng), (7.0, 8.0));
      expect(q.current.phase, SosPhase.sent);
    });

    test('a position that is slow but in time is attached to the saved alert', () async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final q = slow(repo, () async {
        await Future<void>.delayed(const Duration(milliseconds: 80));
        return (lat: 7.0, lng: 8.0);
      });
      addTearDown(q.dispose);
      await q.alert();
      expect(prefs.getString(SosQueue.key), contains('"lat":7.0'), reason: 'kept with it for a restart');
    });

    test('no position in time: the first POST goes after one short wait, not two', () {
      fakeAsync((async) {
        final repo = _Safety();
        var asked = 0;
        final q = slow(repo, () {
          asked++;
          return Completer<SosPosition?>().future; // never answers
        }, wait: const Duration(milliseconds: 150));
        q.alert();
        async.elapse(const Duration(milliseconds: 149));
        expect(repo.attempts, isEmpty, reason: 'still inside the one wait');
        async.elapse(const Duration(milliseconds: 2));
        expect(repo.attempts, hasLength(1), reason: 'sent after one wait; a second wait would still be running');
        expect(repo.sent, hasLength(1));
        expect(repo.sent.single.lat, isNull);
        expect(asked, 1, reason: 'one request for a reading, not one in the sheet and another in the queue');
        q.dispose();
      });
    });

    test('a position that arrives after the wait does not hold the send up or change it', () {
      fakeAsync((async) {
        final repo = _Safety();
        final q = slow(repo, () async {
          await Future<void>.delayed(const Duration(milliseconds: 300));
          return (lat: 9.0, lng: 9.0);
        }, wait: const Duration(milliseconds: 60));
        q.alert();
        async.elapse(const Duration(milliseconds: 61));
        expect(repo.sent, hasLength(1), reason: 'sent at the end of the wait, not when the position came');
        expect(repo.sent.single.lat, isNull);
        async.elapse(const Duration(milliseconds: 300));
        expect(repo.sent, hasLength(1));
        q.dispose();
      });
    });

    test('signing out while the position is awaited: nothing is sent', () async {
      final repo = _Safety();
      final gps = Completer<SosPosition?>();
      String? user = 'u1';
      final q = slow(repo, () => gps.future, uid: () => user);
      addTearDown(q.dispose);
      final done = q.alert();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      user = null;
      await q.userChanged(null);
      gps.complete((lat: 1.0, lng: 1.0));
      await done;
      expect(repo.attempts, isEmpty);
      expect(q.waiting, isEmpty);
    });

    test('the owner is checked again right before the send, whatever was waited for', () async {
      final repo = _Safety();
      final gps = Completer<SosPosition?>();
      var user = 'u1';
      final q = slow(repo, () => gps.future, uid: () => user);
      addTearDown(q.dispose);
      final done = q.alert();
      await Future<void>.delayed(const Duration(milliseconds: 20));
      user = 'u2'; // the session changed with no event yet
      gps.complete((lat: 1.0, lng: 1.0));
      await done;
      expect(repo.attempts, isEmpty, reason: 'never sent under another user');
      expect(q.waiting, isEmpty);
    });
  });

  group('SOS sheet', () {
    testWidgets('Call 112 dials 112 and says it is the phone calling', (tester) async {
      final ctx = await _pump(tester);
      await _openSheet(tester);
      expect(find.text('Call 112'), findsOneWidget);
      expect(find.text('This calls 112 from your phone'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('call-112')));
      expect(ctx.opened.map((u) => u.toString()), ['tel:112']);
    });

    testWidgets('Alert Deligro says "ops have been alerted" only once the server confirmed', (tester) async {
      final repo = _Safety();
      await _pump(tester, safety: repo);
      await _openSheet(tester);
      expect(find.text(sosSentText), findsNothing);
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      expect(find.text('Deligro ops have been alerted'), findsOneWidget);
      expect(find.byKey(const Key('sos-sent')), findsOneWidget);
      expect(find.text(sosQueuedText), findsNothing);
      // The live location went with it.
      expect((repo.sent.single.lat, repo.sent.single.lng), (21.7189, 81.5301));
    });

    testWidgets('no internet: the calls still work, the alert says not sent, then goes when the signal is back', (tester) async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final ctx = await _pump(tester, safety: repo, prefs: {
        // The numbers were saved the last time the rider had signal.
        'emergency_contact_v1': '{"name":"Sunita","phone":"+919123456780","relation":"Wife"}',
        'support_contact_v1': '{"phone":"+91 98765 43210","whatsapp":null}',
      });
      await _openSheet(tester);
      await _tap(tester, find.byKey(const Key('alert-deligro')));

      // Never claims it was sent.
      expect(find.text('Not sent yet — trying again'), findsOneWidget);
      expect(find.text(sosSentText), findsNothing);
      expect(find.byKey(const Key('sos-sent')), findsNothing);

      // The phone calls do not need the internet.
      await _tap(tester, find.byKey(const Key('call-112')));
      await _tap(tester, find.byKey(const Key('call-emergency-contact')));
      await _tap(tester, find.byKey(const Key('call-support-sos')));
      expect(ctx.opened.map((u) => u.toString()), ['tel:112', 'tel:+919123456780', 'tel:+919876543210']);

      // Signal returns; the rider has moved. The next try on the 15 s beat goes
      // through, with the last known location.
      repo.error = null;
      ctx.container.read(latestFixProvider.notifier).set((lat: 21.8, lng: 81.6, at: DateTime.now()));
      await tester.pump(const Duration(seconds: 15));
      await _settle(tester);
      expect(find.text('Deligro ops have been alerted'), findsOneWidget);
      expect(find.text('Not sent yet — trying again'), findsNothing);
      expect((repo.sent.single.lat, repo.sent.single.lng), (21.8, 81.6));
    });

    testWidgets('the phone remembers a pending alert: a new queue picks it up at start', (tester) async {
      final repo = _Safety()..error = ApiException(0, 'network');
      final ctx = await _pump(tester, safety: repo);
      await _openSheet(tester);
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      expect(ctx.container.read(sosQueueProvider).waiting, hasLength(1));
      final stored = (await SharedPreferences.getInstance()).getString(SosQueue.key);
      expect(stored, isNotNull);
      expect(stored, contains('21.7189'));
      ctx.container.read(sosQueueProvider).dispose(); // its retry timer must not outlive the test
    });

    testWidgets('with no GPS reading, the phone\'s last known position is sent', (tester) async {
      final repo = _Safety();
      await _pump(tester, safety: repo, fix: null, current: (lat: 20.1, lng: 80.2));
      await _openSheet(tester);
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      expect((repo.sent.single.lat, repo.sent.single.lng), (20.1, 80.2));
    });

    testWidgets('with no position at all, the alert still goes, without one', (tester) async {
      final repo = _Safety();
      await _pump(tester, safety: repo, fix: null);
      await _openSheet(tester);
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      expect(find.text(sosSentText), findsOneWidget);
      expect(repo.sent.single.lat, isNull);
    });

    testWidgets('a position from over two minutes ago is not sent: a new reading is taken', (tester) async {
      final repo = _Safety();
      await _pump(
        tester,
        safety: repo,
        fix: (lat: 1.0, lng: 1.0),
        fixAge: const Duration(minutes: 3),
        current: (lat: 20.5, lng: 80.5),
      );
      await _openSheet(tester);
      expect(find.text(alertNote), findsOneWidget);
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      expect((repo.sent.single.lat, repo.sent.single.lng), (20.5, 80.5));
    });

    testWidgets('no current position at all: it goes without one and the sheet says ops will call', (tester) async {
      final repo = _Safety();
      await _pump(tester, safety: repo, fix: (lat: 1.0, lng: 1.0), fixAge: const Duration(minutes: 10));
      await _openSheet(tester);
      expect(find.text('Location not available. Your alert still goes to Deligro ops.'), findsOneWidget);
      expect(find.textContaining('Sends your location'), findsNothing);
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      expect(repo.sent.single.lat, isNull);
      expect(repo.sent.single.lng, isNull);
      expect(find.text(sosSentText), findsOneWidget);
    });

    testWidgets('with a position the sheet says it sends the location', (tester) async {
      await _pump(tester);
      await _openSheet(tester);
      expect(find.text('Sends your location to Deligro ops'), findsOneWidget);
      expect(find.textContaining('not available'), findsNothing);
    });

    String stale3h() => '[{"id":"a1","uid":"rider-1","lat":1.0,"lng":2.0,'
        '"positionAt":"${DateTime.now().subtract(const Duration(hours: 3)).toUtc().toIso8601String()}",'
        '"queuedAt":"${DateTime.now().subtract(const Duration(hours: 3)).toUtc().toIso8601String()}"}]';

    testWidgets('an alert from over an hour ago asks, and Discard drops it', (tester) async {
      final repo = _Safety();
      final ctx = await _pump(tester, safety: repo, prefs: {'sos_queue_v1': stale3h()});
      await _openSheet(tester);
      expect(find.byKey(const Key('sos-stale')), findsOneWidget);
      expect(repo.attempts, isEmpty);
      await _tap(tester, find.byKey(const Key('sos-discard')));
      expect(find.byKey(const Key('sos-stale')), findsNothing);
      expect(ctx.container.read(sosQueueProvider).waiting, isEmpty);
      expect(repo.attempts, isEmpty);
    });

    testWidgets('Send now sends a stale alert', (tester) async {
      final repo = _Safety();
      final ctx = await _pump(tester, safety: repo, prefs: {'sos_queue_v1': stale3h()});
      await _openSheet(tester);
      await _tap(tester, find.byKey(const Key('sos-send-now')));
      expect(repo.sent, hasLength(1));
      expect(repo.sent.single.lat, 21.7189, reason: 'not its three-hour-old 1.0, but where the rider is now');
      expect(ctx.container.read(sosQueueProvider).current.phase, SosPhase.sent);
      expect(find.text(sosSentText), findsOneWidget);
    });

    testWidgets('pressing Alert Deligro saves it and shows Sending before any position arrives', (tester) async {
      final repo = _Safety();
      final gps = Completer<({double lat, double lng})?>();
      final ctx = await _pump(tester, safety: repo, fix: null, currentFn: () => gps.future);
      await _openSheet(tester);
      await tester.tap(find.byKey(const Key('alert-deligro')));
      await _settle(tester);
      final q = ctx.container.read(sosQueueProvider);
      expect(q.waiting, hasLength(1), reason: 'saved at once');
      expect(q.current.phase, SosPhase.sending);
      expect(repo.attempts, isEmpty);
      gps.complete((lat: 20.0, lng: 80.0));
      await _settle(tester);
      expect(repo.sent.single.lat, 20.0);
      expect(find.text(sosSentText), findsOneWidget);
    });

    testWidgets('Home shows a banner for a stale alert; it opens Send now / Discard', (tester) async {
      final repo = _Safety();
      final ctx = await _pump(tester, safety: repo, prefs: {'sos_queue_v1': stale3h()});
      expect(find.byKey(const Key('stale-sos-banner')), findsOneWidget);
      expect(find.text(sosStaleText), findsOneWidget);
      await _tap(tester, find.byKey(const Key('stale-sos-banner')));
      expect(find.byKey(const Key('sos-send-now')), findsOneWidget);
      expect(find.byKey(const Key('sos-discard')), findsOneWidget);
      await _tap(tester, find.byKey(const Key('sos-discard')));
      expect(ctx.container.read(sosQueueProvider).waiting, isEmpty);
      // Close the sheet; the banner is gone with the alert.
      tester.state<NavigatorState>(find.byType(Navigator).first).pop();
      await _settle(tester);
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byKey(const Key('stale-sos-banner')), findsNothing);
    });

    testWidgets('no banner when nothing is waiting', (tester) async {
      await _pump(tester);
      expect(find.byKey(const Key('stale-sos-banner')), findsNothing);
    });

    testWidgets('an alert kept by another user is never sent under this session', (tester) async {
      final repo = _Safety();
      final ctx = await _pump(tester, safety: repo, prefs: {
        'sos_queue_v1': '[{"id":"a1","uid":"someone-else","lat":1.0,"lng":2.0,"queuedAt":"${DateTime.now().toUtc().toIso8601String()}"}]',
      });
      await _openSheet(tester);
      await tester.pump(const Duration(seconds: 16));
      await _settle(tester);
      expect(repo.attempts, isEmpty);
      expect(ctx.container.read(sosQueueProvider).waiting, isEmpty);
    });

    testWidgets('no emergency contact: the row is hidden and a link adds one', (tester) async {
      await _pump(tester, safety: _Safety(contact: null));
      await _openSheet(tester);
      expect(find.byKey(const Key('call-emergency-contact')), findsNothing);
      expect(find.byKey(const Key('no-emergency-contact')), findsOneWidget);
      expect(find.text('No emergency contact saved'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('add-emergency-contact')));
      expect(find.text('PROFILE PAGE'), findsOneWidget);
    });

    testWidgets('the emergency contact is called by name', (tester) async {
      final ctx = await _pump(tester);
      await _openSheet(tester);
      expect(find.text('Call Sunita'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('call-emergency-contact')));
      expect(ctx.opened.single.toString(), 'tel:+919123456780');
    });

    testWidgets('Call Deligro support is there when Deligro has a number', (tester) async {
      final ctx = await _pump(tester);
      await _openSheet(tester);
      await _tap(tester, find.byKey(const Key('call-support-sos')));
      expect(ctx.opened.single.toString(), 'tel:+919876543210');
    });

    testWidgets('no sentence in any state claims emergency services were reached', (tester) async {
      final repo = _Safety();
      final ctx = await _pump(tester, safety: repo);
      await _openSheet(tester);
      final texts = <String>[_allText(tester)];
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      texts.add(_allText(tester));
      repo.error = ApiException(0, 'network');
      await _tap(tester, find.byKey(const Key('alert-deligro')));
      texts.add(_allText(tester));
      for (final t in texts) {
        expect(_claim.hasMatch(t), isFalse, reason: t);
      }
      expect(texts.last, contains('Not sent yet'));
      ctx.container.read(sosQueueProvider).dispose();
    });
  });

  group('Safety screen', () {
    testWidgets('has the same four actions and the five report forms', (tester) async {
      await _pump(tester, start: '/safety');
      expect(find.byKey(const Key('call-112')), findsOneWidget);
      expect(find.byKey(const Key('alert-deligro')), findsOneWidget);
      expect(find.byKey(const Key('call-emergency-contact')), findsOneWidget);
      for (final k in ['unsafe_situation', 'accident', 'vehicle_breakdown', 'harassment_threat', 'suspicious_order_location']) {
        await tester.ensureVisible(find.byKey(Key('report-$k')));
        expect(find.byKey(Key('report-$k')), findsOneWidget, reason: k);
      }
      expect(find.text('Harassment or threats'), findsOneWidget);
    });

    testWidgets('a report goes with its kind, note, photos and location, then says ops were alerted', (tester) async {
      final repo = _Safety();
      await _pump(tester, start: '/safety', safety: repo, gallery: (limit) => [testPhoto('a.jpg'), testPhoto('b.png')]);
      await _tap(tester, find.byKey(const Key('report-harassment_threat')));
      expect(find.byKey(const Key('incident-location')), findsOneWidget);
      expect(find.text('Your location is sent with the report.'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('incident-note')), 'Two men blocked the road');
      await tester.pump();
      await _tap(tester, find.byKey(const Key('add-photo')));
      await _tap(tester, find.byKey(const Key('photo-gallery')));
      await _tap(tester, find.byKey(const Key('send-incident')));

      final s = repo.sent.single;
      expect(s.kind, SosKind.harassmentThreat);
      expect(s.note, 'Two men blocked the road');
      expect(s.photos, 2);
      expect((s.lat, s.lng), (21.7189, 81.5301));
      expect(find.text('Report sent. Deligro ops have been alerted.'), findsOneWidget);
    });

    testWidgets('a report that does not reach the server says not sent, keeps the form, and never claims alerted', (tester) async {
      final repo = _Safety()..error = ApiException(0, 'network');
      await _pump(tester, start: '/safety', safety: repo);
      await _tap(tester, find.byKey(const Key('report-accident')));
      await tester.enterText(find.byKey(const Key('incident-note')), 'Slipped on oil');
      await tester.pump();
      await _tap(tester, find.byKey(const Key('send-incident')));
      expect(find.byKey(const Key('incident-error')), findsOneWidget);
      expect(find.textContaining('Not sent'), findsOneWidget);
      expect(find.textContaining('call 112'), findsOneWidget);
      expect(find.byKey(const Key('incident-sent')), findsNothing);
      expect(find.textContaining('have been alerted'), findsNothing);
      expect(tester.widget<TextField>(find.byKey(const Key('incident-note'))).controller!.text, 'Slipped on oil');
    });

    testWidgets('a report with no position says so and still goes', (tester) async {
      final repo = _Safety();
      await _pump(tester, start: '/safety', safety: repo, fix: null);
      await _tap(tester, find.byKey(const Key('report-vehicle_breakdown')));
      expect(find.textContaining("location isn't available"), findsOneWidget);
      await _tap(tester, find.byKey(const Key('send-incident')));
      expect(repo.sent.single.lat, isNull);
      expect(find.byKey(const Key('incident-sent')), findsOneWidget);
    });
  });

  group('wording', () {
    test('no string in the safety feature, its state or its queue claims emergency services were reached', () {
      final files = [
        ...Directory('lib/features/safety').listSync().whereType<File>(),
        File('lib/state/safety.dart'),
        File('lib/core/sos_queue.dart'),
        File('lib/data/safety_repository.dart'),
        File('lib/data/fixtures/fixture_support.dart'),
      ];
      expect(files, isNotEmpty);
      final literal = RegExp(r'''\x27([^\x27\n]{12,})\x27|"([^"\n]{12,})"''');
      final offenders = <String>[];
      for (final f in files) {
        for (final m in literal.allMatches(f.readAsStringSync())) {
          final text = m.group(1) ?? m.group(2)!;
          if (_claim.hasMatch(text)) offenders.add('${f.path}: $text');
        }
      }
      expect(offenders, isEmpty, reason: offenders.join('\n'));
    });

    test('the three sentences are exactly the ones the requirements name', () {
      expect(call112Note, 'This calls 112 from your phone');
      expect(sosSentText, 'Deligro ops have been alerted');
      expect(sosQueuedText, 'Not sent yet — trying again');
    });
  });

  group('Light, dark and 1.3x text', () {
    for (final scale in [1.0, 1.3]) {
      for (final dark in [false, true]) {
        for (final page in ['sheet', 'safety', 'report']) {
          testWidgets('$page at ${scale}x ${dark ? 'dark' : 'light'}', (tester) async {
            await _pump(
              tester,
              start: page == 'sheet' ? '/host' : '/safety',
              brightness: dark ? Brightness.dark : Brightness.light,
              textScale: scale,
            );
            if (page == 'sheet') {
              await _openSheet(tester);
              await _tap(tester, find.byKey(const Key('alert-deligro')));
            }
            if (page == 'report') {
              await _tap(tester, find.byKey(const Key('report-unsafe_situation')));
            }
            expect(tester.takeException(), isNull);
          });
        }
      }
    }
  });
}
