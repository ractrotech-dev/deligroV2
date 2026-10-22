// Every route of the real app router at 1.3x text on a 360x720 phone, in
// light and dark: no RenderFlex overflow and no other FlutterError anywhere.
//
// The data is the fixture backends' (realistic), with the strings that grow
// in real life made as long as a real rider's can be: names, shops, addresses,
// notes, ticket text, big amounts and the longest error words
// (support/scale_world.dart). Every main screen is also shown empty and
// failing. The sheets and dialogs are opened: SOS, deposit, dispute,
// withdraw, the profile edit sheets, the payout account sheet, the break
// menu, the reject sheet, the code sheets, the delivery problem menus and
// forms, the timeline, the update sheet, sign out, a new ticket and the
// safety report form.
//
// Each screen is scrolled to its end (every scrollable, both ways) so that
// rows built lazily are laid out too. No network: Supabase and the website's
// API are `MockClient`s, every repository is a fake.
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/location_service.dart';
import 'package:deligro_rider/core/navigation_launcher.dart';
import 'package:deligro_rider/core/ring.dart';
import 'package:deligro_rider/core/routing.dart';
import 'package:deligro_rider/core/sos_queue.dart';
import 'package:deligro_rider/core/update_check.dart';
import 'package:deligro_rider/features/delivery/proof_photo.dart';
import 'package:deligro_rider/features/delivery/qr_scan_screen.dart';
import 'package:deligro_rider/features/delivery/route_map.dart';
import 'package:deligro_rider/features/help/attachments.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/router.dart';
import 'package:deligro_rider/state/cash.dart';
import 'package:deligro_rider/state/earnings.dart';
import 'package:deligro_rider/state/insights.dart';
import 'package:deligro_rider/state/jobs.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/profile.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/state/safety.dart';
import 'package:deligro_rider/state/support.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'support/fake_geolocator.dart';
import 'support/scale_world.dart';

const _textScale = 1.3;
const _surface = Size(360, 720);
const _riderId = 'rider-1';
const _activeDeliveryId = 'f2000000-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/// How `/api/rider/me` answers.
enum _Me { rider, loading, failing, notRider, needsUpdate }

/// The rider's availability row.
enum _Avail { online, offline, onBreak, untilResumed, stale }

class _Setup {
  final world = ScaleWorld();
  bool signedIn = true;
  _Me me = _Me.rider;
  _Avail avail = _Avail.online;
  bool activeDelivery = false;
  AppUpdate? update;
  Map<String, Object> prefs = {};

  /// `/api/rider/me` stops answering after the first time (the offline banner).
  bool meDropsLater = false;
  int _meCalls = 0;

  /// What `/api/auth/otp/request` answers.
  (int, Object) otpAnswer = (200, {'devMode': true, 'devCode': '123456'});

  Map<String, dynamic> availability(DateTime now) => {
    'isOnline': avail != _Avail.offline,
    'breakUntil': switch (avail) {
      _Avail.onBreak => now.add(const Duration(minutes: 45)).toUtc().toIso8601String(),
      _Avail.untilResumed => '9999-12-31T00:00:00.000Z',
      _ => null,
    },
    'onlineSince': now.subtract(const Duration(hours: 11, minutes: 58)).toUtc().toIso8601String(),
    'lastFixAt': (avail == _Avail.stale ? now.subtract(const Duration(hours: 1)) : now).toUtc().toIso8601String(),
  };

  Map<String, dynamic> meJson() {
    final now = DateTime.now();
    final long = world.long;
    return {
      'id': _riderId,
      'name': long ? longRider : 'Ravi Kumar',
      'phone': '+919876543210',
      'avatarUrl': null,
      'riderCode': long ? 'DR-004212345' : 'DR-0042',
      'availability': availability(now),
      'phase': switch (avail) {
        _Avail.offline => 'offline',
        _Avail.onBreak || _Avail.untilResumed => 'break',
        _Avail.stale => 'stale',
        _Avail.online => 'online',
      },
      'activeDeliveryId': activeDelivery ? _activeDeliveryId : null,
      'features': {'driver.history': true, 'driver.earnings': true},
      'legal': {'privacyUrl': 'https://example.com/privacy', 'termsUrl': 'https://example.com/terms'},
      'profile': {'verification': 'rejected', 'needsAttention': true, 'documentsComplete': false},
    };
  }

  Future<RiderMe> answerMe() async {
    _meCalls++;
    if (meDropsLater && _meCalls > 1) throw ApiException(503, 'server_error');
    return switch (me) {
      _Me.rider => RiderMe.fromJson(meJson()),
      _Me.loading => Completer<RiderMe>().future,
      _Me.failing => throw ApiException(500, 'server_error'),
      _Me.notRider => throw ApiException(403, 'not_rider'),
      _Me.needsUpdate => throw ApiException(404, 'not_configured'),
    };
  }

  Future<http.Response> handle(http.Request req) async {
    http.Response json(int status, Object body) =>
        http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});
    switch (req.url.path) {
      case '/api/rider/status':
        final action = (jsonDecode(req.body) as Map)['action'];
        if (action == 'offline') avail = _Avail.offline;
        if (action == 'online' || action == 'resume') avail = _Avail.online;
        if (action == 'break') avail = _Avail.untilResumed;
        return json(200, {'availability': availability(DateTime.now()), 'phase': 'online'});
      case '/api/rider/signout':
        return json(200, {'ok': true});
      case '/api/app-version':
        return json(200, {'updateAvailable': false, 'forceUpdate': false, 'apkUrl': '', 'releaseNotes': ''});
      case '/api/auth/otp/request':
        return json(otpAnswer.$1, otpAnswer.$2);
      case '/auth/v1/logout':
        return http.Response('', 204);
      default:
        return json(404, {'error': 'not_found'});
    }
  }
}

String _sessionJson(String userId) {
  final exp = DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch ~/ 1000;
  String b64(Object o) => base64Url.encode(utf8.encode(jsonEncode(o))).replaceAll('=', '');
  final jwt = '${b64({'alg': 'HS256'})}.${b64({'sub': userId, 'exp': exp})}.sig';
  return jsonEncode({
    'access_token': jwt,
    'token_type': 'bearer',
    'expires_in': 3600,
    'expires_at': exp,
    'refresh_token': 'refresh',
    'user': {
      'id': userId,
      'aud': 'authenticated',
      'app_metadata': <String, dynamic>{},
      'user_metadata': <String, dynamic>{},
      'created_at': '2026-01-01T00:00:00Z',
    },
  });
}

class _QuietRing extends RingChannel {
  @override
  Future<bool> start(String ringId, {required String title, required String body, int timeoutSec = 180, bool held = true}) async =>
      true;

  @override
  Future<void> stop(String ringId) async {}
}

class _App {
  _App(this.tester, this.container, this.setup, this.label, this.errors);

  final WidgetTester tester;
  final ProviderContainer container;
  final _Setup setup;
  final String label;
  final List<FlutterErrorDetails> errors;

  void go(String path, {Object? extra}) => container.read(routerProvider).go(path, extra: extra);

  Future<void> push(String path, {Object? extra}) async {
    unawaited(container.read(routerProvider).push(path, extra: extra));
    await settle();
  }

  Future<void> settle({int rounds = 8}) => _settle(tester, rounds: rounds);

  /// Taps [f] (scrolled into view first) and lets a sheet or page slide in.
  /// Brings [f] into the tree: every scrollable back to the top, then down a
  /// step at a time until it is built (lists build their rows lazily).
  Future<void> reveal(Finder f) async {
    if (f.evaluate().isNotEmpty) return;
    List<ScrollPosition> positions() => [
      for (final s in tester.stateList<ScrollableState>(find.byType(Scrollable)))
        if (s.position.hasContentDimensions && s.position.hasPixels) s.position,
    ];
    for (final p in positions()) {
      p.jumpTo(p.minScrollExtent);
    }
    await tester.pump();
    for (var round = 0; round < 40 && f.evaluate().isEmpty; round++) {
      var moved = false;
      for (final p in positions()) {
        if (p.pixels < p.maxScrollExtent - 1) {
          p.jumpTo(math.min(p.pixels + p.viewportDimension * 0.5, p.maxScrollExtent));
          moved = true;
        }
      }
      if (!moved) break;
      await tester.pump();
    }
  }

  Future<void> tap(Finder f, {String? step}) async {
    await reveal(f);
    if (f.evaluate().isEmpty) {
      final shown = tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? t.textSpan?.toPlainText()).take(60);
      fail('$label: nothing to tap for ${step ?? f}. On screen: ${shown.join(' | ')}');
    }
    final one = f.first;
    await tester.ensureVisible(one);
    await tester.pump();
    await tester.tap(one, warnIfMissed: false);
    await settle();
    await tester.pump(const Duration(milliseconds: 400));
    await settle(rounds: 3);
    await check(step ?? 'after tapping $f');
  }

  Future<void> enter(Finder f, String text) async {
    await reveal(f);
    await tester.ensureVisible(f.first);
    await tester.enterText(f.first, text);
    await settle(rounds: 3);
  }

  /// Closes the sheet or dialog on top (never a page).
  Future<void> close() async {
    final popup = find.byWidgetPredicate((w) => w is BottomSheet || w is Dialog || w is AlertDialog);
    expect(popup, findsWidgets, reason: '$label: no sheet or dialog to close');
    Navigator.of(tester.element(popup.last)).pop();
    await settle();
    await tester.pump(const Duration(milliseconds: 400));
    await settle(rounds: 2);
  }

  /// Scrolls every scrollable on screen to its end, a step at a time, then
  /// fails on anything that went wrong on the way.
  Future<void> check(String step) async {
    for (var round = 0; round < 40; round++) {
      var moved = false;
      for (final s in tester.stateList<ScrollableState>(find.byType(Scrollable)).toList()) {
        final p = s.position;
        if (!p.hasContentDimensions || !p.hasPixels) continue;
        if (p.pixels < p.maxScrollExtent - 1) {
          p.jumpTo(math.min(p.pixels + p.viewportDimension * 0.6, p.maxScrollExtent));
          moved = true;
        }
      }
      if (!moved) break;
      await tester.pump();
      await settle(rounds: 1);
    }
    _expectClean(errors, '$label · $step');
  }
}

void _expectClean(List<FlutterErrorDetails> errors, String where) {
  if (errors.isEmpty) return;
  final text = errors.map((e) {
    final lines = e.toString().split('\n');
    // Where in the app it happened: the widget the framework blames, else the
    // first frames of the app's own code.
    final culprit = lines.where((l) => l.contains('rider/lib/')).take(2);
    return '${e.exceptionAsString().split('\n').first}\n  at ${culprit.map((l) => l.trim()).join('\n  ')}';
  }).toSet().join('\n');
  errors.clear();
  fail('$where:\n$text');
}

/// Lets futures and route changes finish. Not pumpAndSettle: a countdown or
/// a spinner on screen never settles.
Future<void> _settle(WidgetTester tester, {int rounds = 8}) async {
  for (var i = 0; i < rounds; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Future<_App> _pump(WidgetTester tester, _Setup s, Brightness brightness, String label, List<FlutterErrorDetails> errors) async {
  tester.view.physicalSize = _surface * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);

  final supabase = SupabaseClient(
    'http://localhost:1',
    'test-key',
    httpClient: MockClient(s.handle),
    authOptions: const AuthClientOptions(autoRefreshToken: false),
  );
  addTearDown(() => unawaited(supabase.dispose()));
  if (s.signedIn) await supabase.auth.recoverSession(_sessionJson(_riderId));
  GeolocatorPlatform.instance = FakeGeolocator();
  SharedPreferences.setMockInitialValues({locationDisclosureKey: true, ...s.prefs});
  final api = ApiClient(supabase.auth, client: MockClient(s.handle));
  final w = s.world;
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      supabaseProvider.overrideWithValue(supabase),
      apiProvider.overrideWithValue(api),
      locationHeartbeatProvider.overrideWithValue(null),
      meProvider.overrideWith((ref) {
        ref.watch(userIdProvider);
        return s.answerMe();
      }),
      updateProvider.overrideWith((_) async => s.update),
      jobsRepoProvider.overrideWithValue(ScaleJobs(w)),
      insightsRepoProvider.overrideWithValue(ScaleInsights(w)),
      earningsRepoProvider.overrideWithValue(ScaleEarnings(w)),
      cashRepoProvider.overrideWithValue(ScaleCash(w)),
      profileRepoProvider.overrideWithValue(ScaleProfile(w)),
      supportRepoProvider.overrideWithValue(ScaleSupport(w)),
      notificationsRepoProvider.overrideWithValue(ScaleNotifications(w)),
      safetyRepoProvider.overrideWithValue(ScaleSafety(w)),
      ringChannelProvider.overrideWithValue(_QuietRing()),
      mapTilesEnabledProvider.overrideWithValue(false),
      routingClientProvider.overrideWithValue(
        RoutingClient(client: MockClient((_) async => http.Response('down', 503))),
      ),
      urlOpenerProvider.overrideWithValue((_) async => false),
      qrScannerProvider.overrideWithValue((_) async => null),
      photoTakerProvider.overrideWithValue(() async => null),
      galleryPickerProvider.overrideWithValue((_) async => const []),
      receiptPickerProvider.overrideWithValue(({required camera}) async => null),
      documentChooserProvider.overrideWithValue((_) async => null),
      avatarChooserProvider.overrideWithValue(({required camera}) async => null),
      currentPositionProvider.overrideWithValue(() async => null),
    ],
  );
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: Consumer(
        builder: (context, ref, _) => MaterialApp.router(
          debugShowCheckedModeBanner: false,
          theme: buildTheme(brightness),
          routerConfig: ref.watch(routerProvider),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(textScaler: const TextScaler.linear(_textScale)),
            child: UpdateGate(navigatorKey: rootNavigatorKey, child: child!),
          ),
        ),
      ),
    ),
  );
  await _settle(tester);
  return _App(tester, container, s, label, errors);
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

typedef _Act = Future<void> Function(_App app);

class _Case {
  const _Case(this.name, {this.path, this.extra, this.setup, this.act});

  final String name;

  /// Where to go once the app is up; null stays where the router put it.
  final String? path;
  final Object? Function()? extra;
  final void Function(_Setup s)? setup;
  final _Act? act;
}

/// Pumps the app for [c] and checks it, then each step of [c.act].
Future<void> _run(WidgetTester tester, _Case c, Brightness brightness) async {
  final label = '${c.name} (${brightness.name})';
  final errors = <FlutterErrorDetails>[];
  final previous = FlutterError.onError;
  FlutterError.onError = errors.add;
  _App? app;
  try {
    final s = _Setup();
    c.setup?.call(s);
    app = await _pump(tester, s, brightness, label, errors);
    if (c.path != null) {
      app.go(c.path!, extra: c.extra?.call());
      await app.settle();
    }
    await app.check('first look');
    await c.act?.call(app);
    // Tear the tree down inside the check: timers and listeners end here.
    await tester.pumpWidget(const SizedBox());
    await _settle(tester, rounds: 2);
    _expectClean(errors, '$label · teardown');
  } finally {
    FlutterError.onError = previous;
    // Before the test ends, not in a tear-down: a retry timer (an SOS waiting
    // to send) must be gone by the time the binding checks for timers.
    await tester.pumpWidget(const SizedBox());
    app?.container.dispose();
  }
}

Finder _key(String k) => find.byKey(Key(k));

void _empty(_Setup s) => s.world.empty = true;
void _failing(_Setup s) => s.world.fail = true;
void _short(_Setup s) => s.world.long = false;

/// A main screen as it is, empty, and failing.
List<_Case> _threeWays(String name, String path, {_Act? act}) => [
  _Case(name, path: path, act: act),
  _Case('$name, empty', path: path, setup: _empty),
  _Case('$name, failing', path: path, setup: _failing),
];

final _cases = <_Case>[
  // ---- The gate, before the shell ----
  _Case(
    'login: phone',
    setup: (s) => s.signedIn = false,
    act: (app) async {
      await app.enter(_key('phone-field'), '9876543210');
      await app.tap(find.byType(FilledButton), step: 'code step');
    },
  ),
  _Case(
    'login: phone, refused',
    setup: (s) {
      s.signedIn = false;
      s.otpAnswer = (503, {'error': 'sms_unavailable'});
    },
    act: (app) async {
      await app.enter(_key('phone-field'), '9876543210');
      await app.tap(find.byType(FilledButton), step: 'refused');
    },
  ),
  _Case(
    'login: phone, daily limit',
    setup: (s) {
      s.signedIn = false;
      s.otpAnswer = (429, {'error': 'daily_limit', 'retryAfter': 50000});
    },
    act: (app) async {
      await app.enter(_key('phone-field'), '9876543210');
      await app.tap(find.byType(FilledButton), step: 'limit');
    },
  ),
  _Case(
    'login: email',
    setup: (s) => s.signedIn = false,
    act: (app) => app.tap(_key('tab-email'), step: 'email tab'),
  ),
  _Case('gate: loading', setup: (s) => s.me = _Me.loading),
  _Case('gate: failing', setup: (s) => s.me = _Me.failing),
  _Case('not a rider', setup: (s) => s.me = _Me.notRider),
  _Case('server needs an update', setup: (s) => s.me = _Me.needsUpdate),
  _Case(
    'update required',
    setup: (s) => s.update = (
      updateAvailable: true,
      forceUpdate: true,
      apkUrl: 'https://example.com/rider.apk',
      notes: 'Faster offers, a clearer delivery screen and fixes for older phones. ' * 6,
    ),
  ),
  _Case(
    'update sheet',
    setup: (s) => s.update = (
      updateAvailable: true,
      forceUpdate: false,
      apkUrl: 'https://example.com/rider.apk',
      notes: 'Faster offers, a clearer delivery screen and fixes for older phones. ' * 6,
    ),
  ),
  _Case('location disclosure', path: '/location-disclosure'),
  _Case('location disclosure, read again', path: '/location-disclosure?read=1'),

  // ---- Home ----
  _Case(
    'home: online',
    path: '/home',
    act: (app) async {
      await app.tap(_key('break-button'), step: 'break menu');
      await app.tap(_key('break-until-resume'), step: 'on break');
    },
  ),
  _Case('home: offline', path: '/home', setup: (s) => s.avail = _Avail.offline),
  _Case('home: on a break', path: '/home', setup: (s) => s.avail = _Avail.onBreak),
  _Case('home: waiting for location', path: '/home', setup: (s) => s.avail = _Avail.stale),
  _Case(
    'home: location off',
    path: '/home',
    act: (app) async {
      for (final gate in [LocationGate.serviceOff, LocationGate.needsDisclosure, LocationGate.deniedForever]) {
        app.container.read(locationGateProvider.notifier).set(gate);
        await app.settle();
        await app.check('location notice ${gate.name}');
      }
    },
  ),
  _Case(
    'home: lost connection',
    path: '/home',
    setup: (s) => s.meDropsLater = true,
    act: (app) async {
      app.container.invalidate(meProvider);
      await app.settle();
      await app.check('offline banner');
    },
  ),
  _Case(
    'home: an old SOS alert',
    path: '/home',
    setup: (s) => s.prefs = {
      SosQueue.key: jsonEncode([
        {
          'id': 'f0000000-0000-4000-8000-000000000001',
          'uid': _riderId,
          'lat': null,
          'lng': null,
          'positionAt': null,
          'orderId': null,
          'queuedAt': DateTime.now().subtract(const Duration(hours: 3)).toUtc().toIso8601String(),
          'approved': false,
        },
      ]),
    },
    act: (app) async {
      await app.tap(find.text('Review'), step: 'SOS sheet with the old alert');
    },
  ),
  _Case('home: new rider', path: '/home', setup: _empty),
  _Case('home: figures failing', path: '/home', setup: _failing),
  _Case('home: short words', path: '/home', setup: _short),

  // ---- Jobs ----
  _Case(
    'jobs: offers',
    path: '/jobs',
    act: (app) async {
      await app.tap(find.text('Accept'), step: 'refused accept');
      await app.tap(find.text('Reject'), step: 'reject sheet');
      await app.tap(find.text('Other'), step: 'reject: other');
    },
  ),
  _Case('jobs: offers, short words', path: '/jobs', setup: _short),
  _Case('jobs: offline', path: '/jobs', setup: (s) => s.avail = _Avail.offline),
  _Case('jobs: on a break', path: '/jobs', setup: (s) => s.avail = _Avail.onBreak),
  _Case('jobs: no orders', path: '/jobs', setup: _empty),
  _Case('jobs: failing', path: '/jobs', setup: _failing),
  for (final scenario in ['accepted', 'picked_up', 'on_the_way', 'delivered', 'failed', 'cancelled'])
    _Case(
      'delivery: $scenario',
      path: '/jobs',
      setup: (s) {
        s.world.board = scenario;
        s.activeDelivery = true;
      },
      act: (app) async {
        if (find.byKey(const Key('report-problem')).evaluate().isNotEmpty) {
          await app.tap(_key('report-problem'), step: 'problem menu');
          await app.tap(find.byType(ListTile).first, step: 'problem form');
          await app.tap(find.byType(ChoiceChip).first, step: 'reason picked');
          await app.tap(_key('issue-send'), step: 'refused');
          await app.close();
        }
        if (find.byKey(const Key('timeline-button')).evaluate().isNotEmpty) {
          await app.tap(_key('timeline-button'), step: 'timeline');
          await app.close();
        }
      },
    ),
  _Case(
    'delivery: at the shop',
    path: '/jobs',
    setup: (s) {
      s.world.board = 'arrived_pickup';
      s.activeDelivery = true;
    },
    act: (app) async {
      await app.tap(_key('primary-action'), step: 'pickup code sheet');
      await app.enter(_key('code-field'), '9999');
      await app.check('wrong pickup code');
      await app.close();
      await app.tap(_key('manual-check'), step: 'manual check form');
      await app.close();
      await app.tap(_key('report-problem'), step: 'shop problem menu');
      await app.tap(_key('issue-go_offline'), step: 'hand back form');
      await app.close();
      await app.tap(_key('sos-button'), step: 'SOS sheet');
      await app.tap(_key('alert-deligro'), step: 'SOS sent');
    },
  ),
  _Case(
    'delivery: at the customer',
    path: '/jobs',
    setup: (s) {
      s.world.board = 'exceptions';
      s.activeDelivery = true;
    },
    act: (app) async {
      await app.tap(_key('cant-deliver'), step: "can't deliver menu");
      await app.tap(_key('issue-complete_without_code'), step: 'complete without code form');
      await app.close();
      await app.tap(_key('timeline-button'), step: 'timeline');
    },
  ),

  _Case(
    'delivery: pickup approved by Deligro',
    path: '/jobs',
    setup: (s) {
      s.world.board = 'arrived_pickup';
      s.world.approvals = true;
      s.activeDelivery = true;
    },
  ),
  _Case(
    'delivery: handover approved by Deligro',
    path: '/jobs',
    setup: (s) {
      s.world.board = 'arrived_drop';
      s.world.approvals = true;
      s.activeDelivery = true;
    },
    act: (app) async {
      await app.tap(_key('primary-action'), step: 'delivery code sheet');
      await app.enter(_key('code-field'), '9999');
      await app.check('wrong delivery code');
    },
  ),
  _Case(
    'delivery: signal lost',
    path: '/jobs',
    setup: (s) {
      s.world.board = 'on_the_way';
      s.activeDelivery = true;
    },
    act: (app) async {
      app.setup.world.fail = true;
      await app.container.read(boardProvider.notifier).refresh();
      await app.settle();
      await app.check('details may be out of date');
    },
  ),
  _Case(
    'jobs: signal lost',
    path: '/jobs',
    act: (app) async {
      app.setup.world.fail = true;
      await app.container.read(boardProvider.notifier).refresh();
      await app.settle();
      await app.check('showing your last orders');
    },
  ),

  // ---- Earnings ----
  ..._threeWays('earnings', '/earnings'),
  ..._threeWays('earnings: records', '/earnings/records'),
  _Case('earnings: a record', path: '/earnings/record', extra: () => longRecord(DateTime.now())),
  _Case('earnings: a reversal', path: '/earnings/record', extra: () => longRecord(DateTime.now(), kind: 'adjustment')),
  ..._threeWays('earnings: payouts', '/earnings/payouts'),
  ..._threeWays('earnings: incentives', '/earnings/incentives'),
  ..._threeWays('earnings: statement', '/earnings/statement'),

  // ---- History ----
  ..._threeWays('history', '/history'),
  _Case('history: not delivered, short words', path: '/history?range=week&outcome=not_delivered', setup: _short),
  _Case('history: a delivery', path: '/history/order/f3000000-0000-4000-8000-000000000000'),
  _Case('history: a failed delivery', path: '/history/order/f3000000-0000-4000-8000-000000000001'),
  _Case('history: a reassigned delivery', path: '/history/order/f3000000-0000-4000-8000-000000000003'),
  _Case('history: a delivery, failing', path: '/history/order/f3000000-0000-4000-8000-000000000000', setup: _failing),

  // ---- More ----
  _Case('more', path: '/more'),
  _Case(
    'settings',
    path: '/more/settings',
    setup: (s) => s.activeDelivery = true,
    act: (app) async {
      await app.tap(_key('row-signout'), step: 'sign out while carrying an order');
      await app.close();
    },
  ),
  _Case('privacy', path: '/more/privacy'),
  ..._threeWays('performance', '/more/performance'),

  // ---- Cash ----
  _Case(
    'cash',
    path: '/more/cash',
    act: (app) async {
      await app.tap(_key('deposit-cash'), step: 'deposit sheet');
      await app.tap(find.text('UPI'), step: 'deposit by UPI');
      await app.enter(_key('deposit-amount'), '99999999');
      await app.tap(_key('deposit-send'), step: 'deposit refused');
      await app.close();
      await app.tap(_key('withdraw-long-dep'), step: 'withdraw dialog');
      await app.close();
      await app.tap(find.text('Report a problem'), step: 'dispute sheet');
      await app.enter(_key('dispute-message'), longTicket);
      await app.tap(_key('dispute-send'), step: 'dispute refused');
    },
  ),
  _Case('cash, empty', path: '/more/cash', setup: _empty),
  _Case('cash, failing', path: '/more/cash', setup: _failing),
  _Case('cash, short words', path: '/more/cash', setup: _short),
  ..._threeWays('cash: collections', '/more/cash/collections'),

  // ---- Help ----
  ..._threeWays('help', '/more/help'),
  _Case(
    'help: new ticket',
    path: '/more/help/new',
    act: (app) async {
      await app.tap(find.text('Accident or emergency'), step: 'emergency picked');
      await app.tap(_key('add-photo'), step: 'photo source sheet');
      await app.close();
      await app.enter(_key('ticket-message'), longTicket);
      await app.tap(_key('send-ticket'), step: 'ticket refused');
    },
  ),
  _Case('help: new ticket, failing', path: '/more/help/new', setup: _failing),
  _Case(
    'help: a ticket',
    path: '/more/help/tickets/f7000000-0000-4000-8000-000001234567',
    act: (app) async {
      await app.enter(_key('reply-field'), longTicket);
      await app.tap(_key('send-reply'), step: 'reply refused');
    },
  ),
  _Case('help: a ticket, failing', path: '/more/help/tickets/f7000000-0000-4000-8000-000001234567', setup: _failing),

  // ---- Profile ----
  _Case(
    'profile',
    path: '/more/profile',
    act: (app) async {
      await app.tap(_key('edit-phone'), step: 'phone sheet');
      await app.close();
      await app.tap(_key('edit-address'), step: 'address sheet');
      await app.tap(_key('sheet-submit'), step: 'address refused');
      await app.close();
      await app.tap(_key('edit-emergency'), step: 'emergency contact sheet');
      await app.tap(_key('sheet-submit'), step: 'emergency contact refused');
      await app.close();
      await app.tap(_key('edit-vehicle'), step: 'vehicle sheet');
      await app.close();
      await app.tap(_key('edit-licence'), step: 'licence sheet');
      await app.close();
    },
  ),
  _Case(
    'profile: name and payout account',
    path: '/more/profile',
    setup: _short,
    act: (app) async {
      await app.tap(_key('edit-vehicle'), step: 'vehicle sheet (short)');
      await app.close();
    },
  ),
  _Case(
    'profile: new rider',
    path: '/more/profile',
    setup: _empty,
    act: (app) async {
      await app.tap(_key('edit-name'), step: 'name sheet');
      await app.tap(_key('sheet-submit'), step: 'name refused');
      await app.close();
      await app.tap(_key('edit-payout'), step: 'payout account sheet');
      await app.tap(_key('sheet-submit'), step: 'payout account checks');
      await app.close();
    },
  ),
  _Case('profile, failing', path: '/more/profile', setup: _failing),
  ..._threeWays('documents', '/more/profile/documents'),
  _Case(
    'documents: upload a licence',
    path: '/more/profile/documents/upload/driving_licence',
    act: (app) => app.tap(_key('upload-submit'), step: 'nothing picked'),
  ),
  _Case('documents: upload a photo', path: '/more/profile/documents/upload/photo'),
  _Case('documents: unknown type', path: '/more/profile/documents/upload/passport'),
  _Case(
    'documents: view one',
    path: '/more/profile/documents/view/doc-photo',
    extra: () => 'Driving licence (back side, with address)',
  ),

  // ---- Notifications ----
  ..._threeWays('notifications', '/notifications'),

  // ---- Safety ----
  _Case(
    'safety',
    path: '/safety',
    setup: (s) => s.world.sosOffline = true,
    act: (app) => app.tap(_key('alert-deligro'), step: 'alert waiting to send'),
  ),
  _Case('safety: no emergency contact', path: '/safety', setup: (s) => s.world.noContact = true),
  _Case(
    'safety: report',
    path: '/safety/report',
    act: (app) async {
      await app.enter(find.byType(TextField), longTicket);
      await app.tap(find.text('Send report'), step: 'report sent');
    },
  ),
  _Case(
    'safety: report, refused',
    path: '/safety/report',
    setup: (s) => s.world.sosOffline = true,
    act: (app) => app.tap(find.text('Send report'), step: 'report not sent'),
  ),
];

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  for (final brightness in Brightness.values) {
    group('1.3x text, 360x720, ${brightness.name}', () {
      for (final c in _cases) {
        testWidgets(c.name, (tester) => _run(tester, c, brightness));
      }
    });
  }
}
