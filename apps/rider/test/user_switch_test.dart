// A shared phone: rider A uses the app, then rider B signs in on it. No
// screen may show anything of A's to B: not while B's answers load, not when
// they fail, not as a stale copy. The whole app runs on the real router, with
// A's data made of the long strings in support/scale_world.dart (so they are
// easy to look for) and B's reads failing, or B a brand-new rider.
//
// No network: Supabase and the website's API are `MockClient`s, every
// repository is a fake.
import 'dart:async';
import 'dart:convert';

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/location_service.dart';
import 'package:deligro_rider/core/navigation_launcher.dart';
import 'package:deligro_rider/core/ring.dart';
import 'package:deligro_rider/core/routing.dart';
import 'package:deligro_rider/core/update_check.dart';
import 'package:deligro_rider/features/delivery/proof_photo.dart';
import 'package:deligro_rider/features/delivery/route_map.dart';
import 'package:deligro_rider/features/help/attachments.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/router.dart';
import 'package:deligro_rider/state/cash.dart';
import 'package:deligro_rider/state/earnings.dart';
import 'package:deligro_rider/state/insights.dart';
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

const _a = 'rider-a';
const _b = 'rider-b';

/// What only rider A's data has in it.
const _aStrings = [
  longRider,
  longShop,
  longShopLine,
  longDropLine,
  longCustomer,
  longInstructions,
  longItem,
  longTicket,
  longManager,
  'DR-004212345',
];

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

Map<String, dynamic> _meJson(String uid) {
  final now = DateTime.now().toUtc().toIso8601String();
  final isA = uid == _a;
  return {
    'id': uid,
    'name': isA ? longRider : 'Second Rider',
    'phone': '+919876543210',
    'riderCode': isA ? 'DR-004212345' : 'DR-0099',
    'availability': {'isOnline': true, 'onlineSince': now, 'lastFixAt': now},
    'phase': 'online',
    'activeDeliveryId': isA ? 'f2000000-0000-4000-8000-000000000001' : null,
    'features': {'driver.history': true, 'driver.earnings': true},
  };
}

Future<http.Response> _server(http.Request req) async {
  http.Response json(int status, Object body) =>
      http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});
  return switch (req.url.path) {
    '/api/app-version' => json(200, {'updateAvailable': false, 'forceUpdate': false, 'apkUrl': '', 'releaseNotes': ''}),
    '/auth/v1/logout' => http.Response('', 204),
    _ => json(404, {'error': 'not_found'}),
  };
}

class _QuietRing extends RingChannel {
  @override
  Future<bool> start(String ringId, {required String title, required String body, int timeoutSec = 180, bool held = true}) async =>
      true;

  @override
  Future<void> stop(String ringId) async {}
}

class _App {
  _App(this.tester, this.container, this.supabase, this.world);
  final WidgetTester tester;
  final ProviderContainer container;
  final SupabaseClient supabase;
  final ScaleWorld world;

  String get location => container.read(routerProvider).state.matchedLocation;

  Future<void> go(String path) async {
    container.read(routerProvider).go(path);
    await settle();
  }

  Future<void> settle({int rounds = 8, void Function()? eachFrame}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
      await tester.pump(const Duration(milliseconds: 50));
      eachFrame?.call();
    }
  }
}

/// Fails if anything of rider A's is on screen, anywhere in the tree.
void _noneOfA(String where) {
  for (final s in _aStrings) {
    expect(find.textContaining(s, findRichText: true), findsNothing, reason: '$where shows rider A\'s "$s"');
  }
}

/// Scrolls every scrollable to its end, checking at each step.
Future<void> _scrollChecking(_App app, String where) async {
  for (var round = 0; round < 30; round++) {
    var moved = false;
    for (final s in app.tester.stateList<ScrollableState>(find.byType(Scrollable)).toList()) {
      final p = s.position;
      if (!p.hasContentDimensions || !p.hasPixels) continue;
      if (p.pixels < p.maxScrollExtent - 1) {
        p.jumpTo((p.pixels + p.viewportDimension * 0.6).clamp(0, p.maxScrollExtent));
        moved = true;
      }
    }
    if (!moved) break;
    await app.tester.pump();
    _noneOfA('$where (scrolled)');
  }
}

Future<_App> _pump(WidgetTester tester) async {
  tester.view.physicalSize = const Size(360 * 3, 720 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);

  final supabase = SupabaseClient(
    'http://localhost:1',
    'test-key',
    httpClient: MockClient(_server),
    authOptions: const AuthClientOptions(autoRefreshToken: false),
  );
  addTearDown(() => unawaited(supabase.dispose()));
  await supabase.auth.recoverSession(_sessionJson(_a));
  GeolocatorPlatform.instance = FakeGeolocator();
  SharedPreferences.setMockInitialValues({locationDisclosureKey: true});
  final api = ApiClient(supabase.auth, client: MockClient(_server));
  // Rider A: a delivery in the bag, long words everywhere.
  final w = ScaleWorld()..board = 'picked_up';
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      supabaseProvider.overrideWithValue(supabase),
      apiProvider.overrideWithValue(api),
      locationHeartbeatProvider.overrideWithValue(null),
      meProvider.overrideWith((ref) async {
        final uid = ref.watch(userIdProvider);
        if (uid == null) throw ApiException(401, 'unauthenticated');
        return RiderMe.fromJson(_meJson(uid));
      }),
      updateProvider.overrideWith((_) async => null),
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
          theme: buildTheme(Brightness.light),
          routerConfig: ref.watch(routerProvider),
        ),
      ),
    ),
  );
  final app = _App(tester, container, supabase, w);
  await app.settle();
  return app;
}

/// Every page that shows a rider's own data, as the router knows them.
const _screens = [
  '/home',
  '/jobs',
  '/earnings',
  '/earnings/payouts',
  '/earnings/incentives',
  '/history',
  '/more',
  '/more/cash',
  '/more/performance',
  '/more/profile',
  '/more/profile/documents',
  '/more/help',
  '/notifications',
  '/safety',
  '/more/settings',
];

/// A visits [screen] (and the main tabs, so their data is loaded), then B
/// signs in; [b] sets up how B's reads go.
Future<void> _switchOn(WidgetTester tester, String screen, void Function(ScaleWorld w) b) async {
  final app = await _pump(tester);
  for (final tab in ['/home', '/jobs', '/notifications', '/more/cash', screen]) {
    await app.go(tab);
  }
  expect(app.location, screen);
  if (screen == '/jobs') {
    // Sanity: A's own delivery is what A sees.
    expect(find.textContaining(longCustomer, findRichText: true), findsWidgets);
  }

  b(app.world);
  await app.supabase.auth.recoverSession(_sessionJson(_b));
  // Every frame of the change, not only where it ends.
  await app.settle(rounds: 12, eachFrame: () => _noneOfA('$screen, while B signs in'));
  expect(app.container.read(userIdProvider), _b);

  // B looks at the same page, and the main tabs.
  for (final page in {screen, '/home', '/jobs'}) {
    await app.go(page);
    _noneOfA('$page for B');
    await _scrollChecking(app, '$page for B');
  }

  await tester.pumpWidget(const SizedBox());
  await app.settle(rounds: 2);
  app.container.dispose();
}

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group("B's reads fail: nothing of A's stays up", () {
    for (final screen in _screens) {
      testWidgets(screen, (tester) => _switchOn(tester, screen, (w) => w.fail = true));
    }
  });

  group('B is a new rider: only B\'s own (empty) data shows', () {
    for (final screen in _screens) {
      testWidgets(screen, (tester) => _switchOn(tester, screen, (w) {
            w.long = false;
            w.empty = true;
          }));
    }
  });
}
