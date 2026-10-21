// Location disclosure and the foreground location service. No network, no
// phone: the geolocator is a fake platform (test/support/fake_geolocator.dart)
// and the website's API is a fake RiderRepository.

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/location_service.dart';
import 'package:deligro_rider/data/rider_repository.dart';
import 'package:deligro_rider/features/home/availability_card.dart';
import 'package:deligro_rider/features/onboarding/location_disclosure_screen.dart';
import 'package:deligro_rider/features/settings/settings_screen.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fake_geolocator.dart';

const _prefKey = 'loc_disclosure_v1';

class _Clock {
  DateTime now = DateTime(2026, 10, 21, 9);
  DateTime call() => now;
  void advance(Duration d) => now = now.add(d);
}

typedef _Answer = ({bool online, bool active});

class _Knobs {
  _Answer answer = (online: true, active: false);
  Object? failWith;
  int offlineSignals = 0;
}

/// A service on a fake clock whose posts are recorded.
class _Rig {
  _Rig._(this.prefs, this.geo, this.service, this.clock, this.posts, this._k);

  final SharedPreferences prefs;
  final FakeGeolocator geo;
  final LocationService service;
  final _Clock clock;
  final List<(double, double)> posts;
  final _Knobs _k;

  int get offlineSignals => _k.offlineSignals;
  set answer(_Answer a) => _k.answer = a;
  set failWith(Object? e) => _k.failWith = e;

  static Future<_Rig> make({
    bool accepted = true,
    LocationPermission permission = LocationPermission.whileInUse,
    bool serviceEnabled = true,
  }) async {
    SharedPreferences.setMockInitialValues({if (accepted) _prefKey: true});
    final prefs = await SharedPreferences.getInstance();
    final geo = FakeGeolocator(
      permission: permission,
      serviceEnabled: serviceEnabled,
    );
    GeolocatorPlatform.instance = geo;
    final clock = _Clock();
    final posts = <(double, double)>[];
    final knobs = _Knobs();
    final service = LocationService(
      prefs: prefs,
      post: (lat, lng) async {
        posts.add((lat, lng));
        final e = knobs.failWith;
        if (e != null) throw e;
        return knobs.answer;
      },
      onServerOffline: () => knobs.offlineSignals++,
      now: clock.call,
      ensureNotificationPermission: () async {},
    );
    addTearDown(service.stop);
    return _Rig._(prefs, geo, service, clock, posts, knobs);
  }

  /// A reading arrives from the phone.
  Future<void> reading(double lat, double lng) async {
    geo.emit(fix(lat, lng));
    await pumpEventQueue();
  }
}

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('check()', () {
    test('needsDisclosure until the disclosure is accepted', () async {
      final r = await _Rig.make(accepted: false);
      expect(await r.service.check(), LocationGate.needsDisclosure);
      await r.service.acceptDisclosure();
      expect(r.prefs.getBool(_prefKey), isTrue);
      expect(await r.service.check(), LocationGate.ok);
    });

    test('denied: asks once, and stays denied when the rider says no', () async {
      final r = await _Rig.make(permission: LocationPermission.denied);
      expect(await r.service.check(), LocationGate.denied);
      expect(r.geo.permissionRequests, 1);
    });

    test('denied, then the rider allows it: ok', () async {
      final r = await _Rig.make(permission: LocationPermission.denied);
      r.geo.grantsOnRequest = LocationPermission.whileInUse;
      expect(await r.service.check(), LocationGate.ok);
    });

    test('deniedForever: no prompt, send them to settings', () async {
      final r = await _Rig.make(permission: LocationPermission.deniedForever);
      expect(await r.service.check(), LocationGate.deniedForever);
      expect(r.geo.permissionRequests, 0);
    });

    test('permission but the phone location is off: serviceOff', () async {
      final r = await _Rig.make(serviceEnabled: false);
      expect(await r.service.check(), LocationGate.serviceOff);
    });
  });

  group('start()', () {
    test('runs as a foreground service with the Deligro notification', () async {
      final r = await _Rig.make();
      await r.service.start(activeDelivery: false);
      final s = r.geo.lastSettings;
      expect(s, isA<AndroidSettings>());
      s as AndroidSettings;
      expect(s.accuracy, LocationAccuracy.high);
      expect(s.distanceFilter, 0);
      final n = s.foregroundNotificationConfig!;
      expect(n.notificationTitle, 'Deligro Rider is online');
      expect(
        n.notificationText,
        "Sharing your location with Deligro dispatch while you're online.",
      );
      expect(n.enableWakeLock, isTrue);
      expect(n.setOngoing, isTrue);
    });

    test('starting twice opens one stream', () async {
      final r = await _Rig.make();
      await r.service.start(activeDelivery: false);
      await r.service.start(activeDelivery: false);
      expect(r.geo.streamsOpened, 1);
    });

    test('the first fix is posted at once', () async {
      final r = await _Rig.make();
      await r.service.start(activeDelivery: false);
      await r.reading(21.71, 81.53);
      expect(r.posts, [(21.71, 81.53)]);
    });

    test('10 readings over 20 s idle: one post, the next after 30 s', () async {
      final r = await _Rig.make();
      await r.service.start(activeDelivery: false);
      for (var i = 0; i < 10; i++) {
        await r.reading(21.71 + i / 1000, 81.53);
        r.clock.advance(const Duration(seconds: 2));
      }
      expect(r.posts, hasLength(1));
      r.clock.advance(const Duration(seconds: 10)); // 30 s since the first
      await r.reading(21.72, 81.54);
      expect(r.posts, hasLength(2));
      expect(r.posts.last, (21.72, 81.54));
    });

    test('on an active delivery: one per 10 s', () async {
      final r = await _Rig.make();
      await r.service.start(activeDelivery: true);
      for (var i = 0; i < 10; i++) {
        await r.reading(21.71 + i / 1000, 81.53);
        r.clock.advance(const Duration(seconds: 2));
      }
      // Readings at 0, 2, ... 18 s: posts at 0 and 10 s.
      expect(r.posts, hasLength(2));
    });

    test('setActiveDelivery switches the cadence either way', () async {
      final r = await _Rig.make();
      await r.service.start(activeDelivery: false);
      await r.reading(21.71, 81.53);
      r.clock.advance(const Duration(seconds: 10));
      await r.reading(21.71, 81.54);
      expect(r.posts, hasLength(1), reason: '10 s is too soon when idle');

      await r.service.setActiveDelivery(true);
      await r.reading(21.71, 81.55);
      expect(r.posts, hasLength(2), reason: '10 s is enough on a delivery');

      r.clock.advance(const Duration(seconds: 10));
      await r.service.setActiveDelivery(false);
      await r.reading(21.71, 81.56);
      expect(r.posts, hasLength(2), reason: 'back to 30 s');
    });

    test('a silent stream gets a heartbeat reading after 30 s', () async {
      final r = await _Rig.make();
      r.geo.current = fix(21.7, 81.5);
      await r.service.start(activeDelivery: false);
      await r.reading(21.71, 81.53);

      r.clock.advance(const Duration(seconds: 20));
      await r.service.heartbeat();
      expect(r.geo.currentPositionCalls, 0, reason: 'not silent long enough');

      r.clock.advance(const Duration(seconds: 10));
      await r.service.heartbeat();
      expect(r.geo.currentPositionCalls, 1);
      expect(r.posts.last, (21.7, 81.5));
    });

    test('a heartbeat that cannot read the phone is not an error', () async {
      final r = await _Rig.make();
      await r.service.start(activeDelivery: false);
      r.clock.advance(const Duration(seconds: 31));
      await r.service.heartbeat(); // geo.current is null: it throws
      expect(r.posts, isEmpty);
      expect(r.service.running, isTrue);
    });
  });

  group('what the server says', () {
    test('online:false stops the stream and asks for a refresh', () async {
      final r = await _Rig.make();
      r.answer = (online: false, active: false);
      await r.service.start(activeDelivery: false);
      await r.reading(21.71, 81.53);

      expect(r.service.running, isFalse);
      expect(r.geo.streamsCancelled, 1);
      expect(r.geo.streaming, isFalse);
      expect(r.offlineSignals, 1);
    });

    test('online:false in an error body is not "offline" (presence failed)', () async {
      final r = await _Rig.make();
      r.failWith = ApiException(
        500,
        'server_error',
        body: {'error': 'server_error', 'online': false, 'active': false},
      );
      await r.service.start(activeDelivery: false);
      await r.reading(21.71, 81.53);
      expect(r.service.running, isTrue);
      expect(r.offlineSignals, 0);
    });

    test('503 migration_pending: keeps running, tries once per 2 min', () async {
      final r = await _Rig.make();
      r.failWith = ApiException(503, 'migration_pending');
      await r.service.start(activeDelivery: true); // even on the fast cadence
      await r.reading(21.71, 81.53);
      expect(r.posts, hasLength(1));
      expect(r.service.running, isTrue);

      for (var i = 0; i < 11; i++) {
        r.clock.advance(const Duration(seconds: 10));
        await r.reading(21.71, 81.53);
      }
      expect(r.posts, hasLength(1), reason: '110 s in: still waiting');

      r.clock.advance(const Duration(seconds: 10)); // 120 s
      await r.reading(21.71, 81.54);
      expect(r.posts, hasLength(2));

      // A good answer ends the back-off.
      r.failWith = null;
      r.clock.advance(const Duration(minutes: 2));
      await r.reading(21.71, 81.55);
      expect(r.posts, hasLength(3));
      r.clock.advance(const Duration(seconds: 10));
      await r.reading(21.71, 81.56);
      expect(r.posts, hasLength(4));
    });

    test('a dead network does not stop the service', () async {
      final r = await _Rig.make();
      r.failWith = ApiException(0, 'network');
      await r.service.start(activeDelivery: false);
      await r.reading(21.71, 81.53);
      expect(r.service.running, isTrue);
      expect(r.offlineSignals, 0);
    });
  });

  group('stop()', () {
    test('cancels the stream, and is harmless twice', () async {
      final r = await _Rig.make();
      await r.service.start(activeDelivery: false);
      await r.service.stop();
      expect(r.geo.streamsCancelled, 1);
      expect(r.service.running, isFalse);
      await r.service.stop();
      expect(r.geo.streamsCancelled, 1);
    });

    test('can start again; the first fix of a new shift is immediate', () async {
      final r = await _Rig.make();
      await r.service.start(activeDelivery: false);
      await r.reading(21.71, 81.53);
      await r.service.stop();
      await r.service.start(activeDelivery: false);
      await r.reading(21.72, 81.54);
      expect(r.posts, hasLength(2));
    });
  });

  group('going online (the availability card)', () {
    testWidgets('first time: the disclosure comes first; Not now stays offline', (
      tester,
    ) async {
      final h = await _pumpCard(tester, accepted: false);
      await _tap(tester, _switch);

      expect(find.text('Continue'), findsOneWidget);
      expect(find.text('Not now'), findsOneWidget);

      await _tap(tester, find.text('Not now'));
      expect(h.repo.statusCalls, isEmpty);
      expect(find.text("You're offline"), findsOneWidget);
      expect(h.geo.streamsOpened, 0);
      expect(h.prefs.getBool(_prefKey), isNot(true));
    });

    testWidgets('Continue is remembered; then online, and sharing starts', (
      tester,
    ) async {
      final h = await _pumpCard(tester, accepted: false);
      await _tap(tester, _switch);
      await _tap(tester, find.text('Continue'));

      expect(h.prefs.getBool(_prefKey), isTrue);
      expect(h.repo.statusCalls, ['online']);
      expect(h.geo.streamsOpened, 1);
      expect(find.text("You're online"), findsOneWidget);

      // Going offline stops it; the next time there is no disclosure.
      await _tap(tester, _switch);
      expect(h.repo.statusCalls, ['online', 'offline']);
      expect(h.geo.streamsCancelled, 1);
      await _tap(tester, _switch);
      expect(find.text('Continue'), findsNothing);
      expect(h.repo.statusCalls, ['online', 'offline', 'online']);
    });

    testWidgets('permission denied: says so, offers Open settings, stays offline', (
      tester,
    ) async {
      final h = await _pumpCard(tester, permission: LocationPermission.denied);
      await _tap(tester, _switch);

      expect(
        find.text('Deligro needs your location to send you orders.'),
        findsOneWidget,
      );
      expect(h.repo.statusCalls, isEmpty);
      expect(find.text("You're offline"), findsOneWidget);

      await _tap(tester, find.text('Open settings'));
      expect(h.geo.appSettingsOpened, 1);
    });

    testWidgets('denied for good: the same message, Open settings', (tester) async {
      final h = await _pumpCard(
        tester,
        permission: LocationPermission.deniedForever,
      );
      await _tap(tester, _switch);
      expect(
        find.text('Deligro needs your location to send you orders.'),
        findsOneWidget,
      );
      await _tap(tester, find.text('Open settings'));
      expect(h.geo.appSettingsOpened, 1);
      expect(h.repo.statusCalls, isEmpty);
    });

    testWidgets('phone location off: a Turn on location prompt', (tester) async {
      final h = await _pumpCard(tester, serviceEnabled: false);
      await _tap(tester, _switch);

      expect(find.text('Turn on location'), findsOneWidget);
      expect(h.repo.statusCalls, isEmpty);

      await _tap(tester, find.text('Turn on location'));
      expect(h.geo.locationSettingsOpened, 1);
    });

    testWidgets('the notice goes away when the rider tries again and it works', (
      tester,
    ) async {
      final h = await _pumpCard(tester, permission: LocationPermission.denied);
      await _tap(tester, _switch);
      expect(find.text('Open settings'), findsOneWidget);

      h.geo.permission = LocationPermission.whileInUse;
      await _tap(tester, _switch);
      expect(find.text('Open settings'), findsNothing);
      expect(h.repo.statusCalls, ['online']);
    });

    testWidgets('if setStatus fails the service never starts', (tester) async {
      final h = await _pumpCard(tester);
      h.repo.statusError = ApiException(409, 'active_delivery');
      await _tap(tester, _switch);

      expect(h.repo.statusCalls, ['online']);
      expect(h.geo.streamsOpened, 0);
      expect(find.text("You're offline"), findsOneWidget);
    });

    testWidgets('already online when the app opens: sharing resumes', (
      tester,
    ) async {
      final h = await _pumpCard(tester, startOnline: true);
      expect(h.geo.streamsOpened, 1);
      expect(find.text("You're online"), findsOneWidget);
    });

    testWidgets('already online but the permission is gone: no stream, no crash', (
      tester,
    ) async {
      final h = await _pumpCard(
        tester,
        startOnline: true,
        permission: LocationPermission.deniedForever,
      );
      expect(h.geo.streamsOpened, 0);
      expect(tester.takeException(), isNull);
    });
  });

  group('stopping with the session', () {
    test('signing out stops it', () async {
      final h = await _container();
      await h.container
          .read(locationServiceProvider)
          .start(activeDelivery: false);
      expect(h.geo.streaming, isTrue);

      h.uid.set(null);
      await pumpEventQueue();
      expect(h.geo.streaming, isFalse);
    });

    test('a different rider signing in stops it', () async {
      final h = await _container();
      await h.container
          .read(locationServiceProvider)
          .start(activeDelivery: false);
      h.uid.set('rider-2');
      await pumpEventQueue();
      expect(h.geo.streaming, isFalse);
    });

    test('the gate sending the user to /not-rider stops it', () async {
      final h = await _container();
      await h.container
          .read(locationServiceProvider)
          .start(activeDelivery: false);
      h.meError.set(ApiException(403, 'not_rider'));
      await pumpEventQueue();
      expect(h.geo.streaming, isFalse);
    });

    test('a lost connection on a refresh does not stop it', () async {
      final h = await _container();
      await h.container
          .read(locationServiceProvider)
          .start(activeDelivery: false);
      h.meError.set(ApiException(0, 'network'));
      await pumpEventQueue();
      expect(h.geo.streaming, isTrue);
    });

    test('the provider being disposed stops it', () async {
      final h = await _container();
      await h.container
          .read(locationServiceProvider)
          .start(activeDelivery: false);
      h.container.dispose();
      await pumpEventQueue();
      expect(h.geo.streaming, isFalse);
    });
  });

  group('the disclosure screen', () {
    testWidgets('says what, when, why, who and how to stop', (tester) async {
      await _pumpDisclosure(tester);
      for (final t in [
        'precise location',
        'Only while you are online',
        'offers near you',
        'live tracking',
        'Deligro dispatch',
        'only while you carry their order',
        'Go offline',
      ]) {
        expect(find.textContaining(t), findsWidgets, reason: t);
      }
    });

    testWidgets('Settings opens it for reading', (tester) async {
      SharedPreferences.setMockInitialValues({});
      GeolocatorPlatform.instance = FakeGeolocator();
      final container = ProviderContainer(
        overrides: [
          prefsProvider.overrideWithValue(
            await SharedPreferences.getInstance(),
          ),
          riderRepoProvider.overrideWithValue(_FakeRepo()),
        ],
      );
      addTearDown(container.dispose);
      final router = GoRouter(
        routes: [
          GoRoute(path: '/', builder: (_, _) => const SettingsScreen()),
          locationDisclosureRoute,
        ],
      );
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp.router(
            theme: buildTheme(Brightness.light),
            routerConfig: router,
          ),
        ),
      );
      await _settle(tester);
      await _tap(tester, find.byKey(const Key('row-location')));
      expect(find.textContaining('precise location'), findsWidgets);
      expect(find.text('Not now'), findsNothing);
      await _tap(tester, find.text('Close'));
      expect(find.byKey(const Key('row-location')), findsOneWidget);
    });
  });
}

// ---------------------------------------------------------------------------

final _switch = find.byKey(const Key('availability-switch'));

Future<void> _settle(WidgetTester tester, {int rounds = 8}) async {
  for (var i = 0; i < rounds; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump(const Duration(milliseconds: 60));
  }
}

Future<void> _tap(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await _settle(tester);
}

/// Just the parts of the website the location flow talks to.
class _FakeRepo implements RiderRepository {
  final statusCalls = <String>[];
  Object? statusError;

  @override
  Future<RiderAvailabilityDto> setStatus(String action, {int? minutes}) async {
    statusCalls.add(action);
    final e = statusError;
    if (e != null) throw e;
    return RiderAvailabilityDto(
      isOnline: action != 'offline',
      onlineSince: action == 'online' ? DateTime.now() : null,
      lastFixAt: action == 'online' ? DateTime.now() : null,
    );
  }

  @override
  Future<_Answer> postLocation(double lat, double lng) async =>
      (online: true, active: false);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Cell<T> extends Notifier<T> {
  _Cell(this._initial);
  final T _initial;
  @override
  T build() => _initial;
  void set(T v) => state = v;
}

NotifierProvider<_Cell<T>, T> _cell<T>(T initial) =>
    NotifierProvider<_Cell<T>, T>(() => _Cell(initial));

class _Handle<T> {
  _Handle(this._c, this._p);
  final ProviderContainer _c;
  final NotifierProvider<_Cell<T>, T> _p;
  void set(T v) => _c.read(_p.notifier).set(v);
}

class _CardHarness {
  _CardHarness(this.repo, this.geo, this.prefs);
  final _FakeRepo repo;
  final FakeGeolocator geo;
  final SharedPreferences prefs;
}

Future<_CardHarness> _pumpCard(
  WidgetTester tester, {
  bool accepted = true,
  LocationPermission permission = LocationPermission.whileInUse,
  bool serviceEnabled = true,
  bool startOnline = false,
}) async {
  tester.view.physicalSize = const Size(360 * 3, 800 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);

  SharedPreferences.setMockInitialValues({if (accepted) _prefKey: true});
  final prefs = await SharedPreferences.getInstance();
  final geo = FakeGeolocator(
    permission: permission,
    serviceEnabled: serviceEnabled,
  );
  GeolocatorPlatform.instance = geo;
  final repo = _FakeRepo();
  final availability = startOnline
      ? RiderAvailabilityDto(
          isOnline: true,
          onlineSince: DateTime.now(),
          lastFixAt: DateTime.now(),
        )
      : RiderAvailabilityDto.offline;
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      riderRepoProvider.overrideWithValue(repo),
      locationHeartbeatProvider.overrideWithValue(null),
      meProvider.overrideWith(
        (ref) async =>
            RiderMe(id: 'rider-1', availability: availability, phase: 'offline'),
      ),
    ],
  );
  addTearDown(container.dispose);

  final router = GoRouter(
    routes: [
      GoRoute(
        path: '/',
        builder: (_, _) => const Scaffold(
          body: SingleChildScrollView(child: AvailabilityCard()),
        ),
      ),
      locationDisclosureRoute,
    ],
  );
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: buildTheme(Brightness.light),
        routerConfig: router,
      ),
    ),
  );
  await _settle(tester);
  return _CardHarness(repo, geo, prefs);
}

Future<void> _pumpDisclosure(WidgetTester tester) async {
  tester.view.physicalSize = const Size(360 * 3, 800 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({});
  GeolocatorPlatform.instance = FakeGeolocator();
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      riderRepoProvider.overrideWithValue(_FakeRepo()),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        theme: buildTheme(Brightness.light),
        home: const LocationDisclosureScreen(decision: true),
      ),
    ),
  );
  await _settle(tester);
}

class _SessionHarness {
  _SessionHarness(this.container, this.geo, this.uid, this.meError);
  final ProviderContainer container;
  final FakeGeolocator geo;
  final _Handle<String?> uid;
  final _Handle<Object?> meError;
}

Future<_SessionHarness> _container() async {
  SharedPreferences.setMockInitialValues({_prefKey: true});
  final geo = FakeGeolocator();
  GeolocatorPlatform.instance = geo;
  final uidCell = _cell<String?>('rider-1');
  final errCell = _cell<Object?>(null);
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      riderRepoProvider.overrideWithValue(_FakeRepo()),
      userIdProvider.overrideWith((ref) => ref.watch(uidCell)),
      meProvider.overrideWith((ref) async {
        final e = ref.watch(errCell);
        if (e != null) throw e;
        return RiderMe(
          id: 'rider-1',
          availability: RiderAvailabilityDto.offline,
          phase: 'offline',
        );
      }),
    ],
  );
  addTearDown(container.dispose);
  // The app reads the service at start; the session listeners live in it.
  container.listen(locationServiceProvider, (_, _) {});
  await container.read(meProvider.future);
  return _SessionHarness(
    container,
    geo,
    _Handle(container, uidCell),
    _Handle(container, errCell),
  );
}
