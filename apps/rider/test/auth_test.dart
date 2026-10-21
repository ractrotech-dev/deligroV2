// Sign-in and the rider gate: the login screen, the OTP and email flows
// against fake servers, and where `/api/rider/me` sends a signed-in user.
// No network: Supabase and the website's API are `MockClient`s.
import 'dart:async';
import 'dart:convert';

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/data/auth_repository.dart';
import 'package:deligro_rider/data/rider_repository.dart';
import 'package:deligro_rider/features/auth/login_screen.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/router.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

const _meBody = {
  'id': 'rider-1',
  'name': 'Ravi Kumar',
  'phone': '+919876543210',
  'avatarUrl': null,
  'riderCode': 'DR-0042',
  'availability': {
    'isOnline': false,
    'breakUntil': null,
    'onlineSince': null,
    'lastFixAt': null,
  },
  'phase': 'offline',
  'activeDeliveryId': null,
  'features': {
    'driver.history': true,
    'driver.earnings': false,
    'driver.call_customer': true,
    'driver.navigation': true,
    'driver.profile_edit': true,
  },
  'legal': {'privacyUrl': 'https://example.com/privacy', 'termsUrl': null},
};

/// A fake website + Supabase. Routes by path; every request is recorded.
class _Server {
  final seen = <http.Request>[];

  /// `/api/rider/me`.
  int meStatus = 200;
  Object meBody = _meBody;

  /// `/api/auth/otp/request`.
  int otpStatus = 200;
  Object otpBody = {'ok': true, 'devMode': false};

  /// `/auth/v1/token` (email + password).
  int tokenStatus = 400;
  Object tokenBody = {
    'code': 'invalid_credentials',
    'error_code': 'invalid_credentials',
    'msg': 'Invalid login credentials',
  };

  /// Throw instead of answering: no connection.
  bool offline = false;

  /// Answer for `/api/rider/signout`.
  int signoutStatus = 200;

  int count(String path) => seen.where((r) => r.url.path == path).length;

  Future<http.Response> handle(http.Request req) async {
    seen.add(req);
    if (offline) throw const _Offline();
    http.Response json(int status, Object body) => http.Response(
          jsonEncode(body),
          status,
          headers: {'content-type': 'application/json'},
        );
    return switch (req.url.path) {
      '/api/rider/me' => json(meStatus, meBody),
      '/api/rider/signout' => json(signoutStatus, signoutStatus < 300 ? {'ok': true} : {'error': 'migration_pending'}),
      '/api/rider/status' => json(200, {'availability': _meBody['availability'], 'phase': 'offline'}),
      '/api/rider/location' => json(200, {'ok': true, 'online': true, 'active': false}),
      '/api/auth/otp/request' => json(otpStatus, otpBody),
      '/auth/v1/token' => json(tokenStatus, tokenBody),
      '/auth/v1/logout' => http.Response('', 204),
      _ => json(404, {'error': 'not_found'}),
    };
  }
}

class _Offline implements Exception {
  const _Offline();
}

/// A session the SDK accepts without a round trip: unexpired, with a JWT
/// whose payload carries `exp`.
String _sessionJson() {
  final exp = DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch ~/ 1000;
  String b64(Object o) => base64Url.encode(utf8.encode(jsonEncode(o))).replaceAll('=', '');
  final jwt = '${b64({'alg': 'HS256'})}.${b64({'sub': 'rider-1', 'exp': exp})}.sig';
  return jsonEncode({
    'access_token': jwt,
    'token_type': 'bearer',
    'expires_in': 3600,
    'expires_at': exp,
    'refresh_token': 'refresh',
    'user': {
      'id': 'rider-1',
      'aud': 'authenticated',
      'app_metadata': <String, dynamic>{},
      'user_metadata': <String, dynamic>{},
      'created_at': '2026-01-01T00:00:00Z',
    },
  });
}

SupabaseClient _supabase(_Server server) {
  final c = SupabaseClient(
    'http://localhost:1',
    'test-key',
    httpClient: MockClient(server.handle),
    authOptions: const AuthClientOptions(autoRefreshToken: false),
  );
  // Not awaited: inside testWidgets (fake time) a close that needs the event
  // loop would hang the teardown.
  addTearDown(() {
    unawaited(c.dispose());
  });
  return c;
}

Future<SharedPreferences> _prefs([Map<String, Object> values = const {}]) async {
  SharedPreferences.setMockInitialValues(values);
  return SharedPreferences.getInstance();
}

class _Harness {
  _Harness(this.server, this.supabase, this.container);
  final _Server server;
  final SupabaseClient supabase;
  final ProviderContainer container;
}

Future<_Harness> _pumpApp(
  WidgetTester tester, {
  required _Server server,
  bool signedIn = false,
  Map<String, Object> prefs = const {},
}) async {
  final supabase = _supabase(server);
  if (signedIn) await supabase.auth.recoverSession(_sessionJson());
  final overrides = [
    prefsProvider.overrideWithValue(await _prefs(prefs)),
    supabaseProvider.overrideWithValue(supabase),
    apiProvider.overrideWithValue(ApiClient(supabase.auth, client: MockClient(server.handle))),
  ];
  final container = ProviderContainer(overrides: overrides);
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(
    container: container,
    child: Consumer(
      builder: (context, ref, _) => MaterialApp.router(
        theme: buildTheme(Brightness.light),
        routerConfig: ref.watch(routerProvider),
      ),
    ),
  ));
  await _settle(tester);
  return _Harness(server, supabase, container);
}

/// Lets futures and route changes finish. Not pumpAndSettle: a spinner on
/// screen never settles.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump(const Duration(milliseconds: 60));
  }
}

String _location(_Harness h) {
  final router = h.container.read(routerProvider);
  return router.state.matchedLocation;
}

Finder _filled(String label) => find.widgetWithText(FilledButton, label);

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('phone OTP', () {
    testWidgets('an invalid phone shows the server\'s friendly error', (tester) async {
      final server = _Server()
        ..otpStatus = 400
        ..otpBody = {'error': 'invalid_phone'};
      await _pumpApp(tester, server: server);
      expect(find.text('Phone OTP'), findsOneWidget);

      await tester.enterText(find.byKey(const Key('phone-field')), '9876543210');
      await tester.pump();
      await tester.tap(_filled('Get OTP'));
      await _settle(tester);

      expect(find.text('Enter a valid 10-digit Indian mobile number.'), findsOneWidget);
      expect(server.count('/api/auth/otp/request'), 1);
      final sent = jsonDecode(server.seen.firstWhere((r) => r.url.path == '/api/auth/otp/request').body);
      expect(sent, {'phone': '+919876543210'});
    });

    testWidgets('the same error reads in Hindi when the app is Hindi', (tester) async {
      final server = _Server()
        ..otpStatus = 400
        ..otpBody = {'error': 'invalid_phone'};
      await _pumpApp(tester, server: server, prefs: {'lang': 'hi'});

      await tester.enterText(find.byKey(const Key('phone-field')), '9876543210');
      await tester.pump();
      await tester.tap(_filled('OTP पाएँ'));
      await _settle(tester);

      expect(find.text('10 अंकों का सही भारतीय मोबाइल नंबर डालें।'), findsOneWidget);
    });

    testWidgets('a sent code moves to the code step and shows the test-mode code', (tester) async {
      final server = _Server()..otpBody = {'ok': true, 'devMode': true, 'devCode': '123456'};
      await _pumpApp(tester, server: server);

      await tester.enterText(find.byKey(const Key('phone-field')), '9876543210');
      await tester.pump();
      await tester.tap(_filled('Get OTP'));
      await _settle(tester);

      expect(find.text('Enter the OTP'), findsOneWidget);
      expect(find.textContaining('123456'), findsOneWidget);
      expect(find.text('Change number'), findsOneWidget);
    });

    testWidgets('no connection says so', (tester) async {
      final server = _Server();
      await _pumpApp(tester, server: server);
      server.offline = true;

      await tester.enterText(find.byKey(const Key('phone-field')), '9876543210');
      await tester.pump();
      await tester.tap(_filled('Get OTP'));
      await _settle(tester);

      expect(find.text('No connection. Check your internet and try again.'), findsOneWidget);
    });
  });

  group('email and password', () {
    Future<void> signIn(WidgetTester tester, {String lang = 'en'}) async {
      await tester.tap(find.text(lang == 'hi' ? 'ईमेल और पासवर्ड' : 'Email & password'));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.enterText(find.byKey(const Key('email-field')), 'ravi@example.com');
      await tester.enterText(find.byKey(const Key('password-field')), 'not-the-password');
      await tester.pump();
      await tester.tap(_filled(lang == 'hi' ? 'साइन इन करें' : 'Sign in'));
      await _settle(tester);
    }

    testWidgets('invalid_credentials shows "Wrong email or password."', (tester) async {
      final server = _Server();
      await _pumpApp(tester, server: server);
      await signIn(tester);

      expect(find.text('Wrong email or password.'), findsOneWidget);
      expect(server.count('/auth/v1/token'), 1);
    });

    testWidgets('invalid_credentials shows the Hindi message in Hindi', (tester) async {
      final server = _Server();
      await _pumpApp(tester, server: server, prefs: {'lang': 'hi'});
      await signIn(tester, lang: 'hi');

      expect(find.text('ईमेल या पासवर्ड गलत है।'), findsOneWidget);
    });

    testWidgets('no connection shows the network message, not "wrong password"', (tester) async {
      final server = _Server();
      await _pumpApp(tester, server: server);
      server.offline = true;
      await signIn(tester);

      expect(find.text('No connection. Check your internet and try again.'), findsOneWidget);
      expect(find.text('Wrong email or password.'), findsNothing);
    });

    test('AuthRepository maps Supabase failures to typed errors', () async {
      final server = _Server();
      final repo = AuthRepository(_supabase(server), ApiClient(_supabase(server).auth));

      await expectLater(
        repo.signInWithEmail('a@b.co', 'x'),
        throwsA(isA<SignInException>().having((e) => e.kind, 'kind', SignInFailure.invalidCredentials)),
      );

      server.offline = true;
      await expectLater(
        repo.signInWithEmail('a@b.co', 'x'),
        throwsA(isA<SignInException>().having((e) => e.kind, 'kind', SignInFailure.network)),
      );
    });
  });

  group('the rider gate', () {
    testWidgets('signed out goes to /login', (tester) async {
      final h = await _pumpApp(tester, server: _Server());
      expect(_location(h), '/login');
      expect(h.server.count('/api/rider/me'), 0);
    });

    testWidgets('a rider goes to /home', (tester) async {
      final h = await _pumpApp(tester, server: _Server(), signedIn: true);
      expect(_location(h), '/home');
      final me = await h.container.read(meProvider.future);
      expect(me.riderCode, 'DR-0042');
    });

    testWidgets('me() 403 not_rider goes to /not-rider and offers Sign out', (tester) async {
      final server = _Server()
        ..meStatus = 403
        ..meBody = {'error': 'not_rider'};
      final h = await _pumpApp(tester, server: server, signedIn: true);

      expect(_location(h), '/not-rider');
      expect(
        find.text('This account isn\'t a Deligro rider. Ask Deligro ops to enable rider access.'),
        findsOneWidget,
      );
      expect(_filled('Sign out'), findsOneWidget);

      await tester.tap(_filled('Sign out'));
      await _settle(tester);
      expect(h.supabase.auth.currentSession, isNull);
      expect(_location(h), '/login');
    });

    testWidgets('the not-rider message is in Hindi in Hindi', (tester) async {
      final server = _Server()
        ..meStatus = 403
        ..meBody = {'error': 'not_rider'};
      await _pumpApp(tester, server: server, signedIn: true, prefs: {'lang': 'hi'});

      expect(find.text('साइन आउट करें'), findsOneWidget);
    });

    testWidgets('me() 401 signs out and goes to /login', (tester) async {
      final server = _Server()
        ..meStatus = 401
        ..meBody = {'error': 'unauthenticated'};
      final h = await _pumpApp(tester, server: server, signedIn: true);

      expect(h.supabase.auth.currentSession, isNull);
      expect(_location(h), '/login');
    });

    testWidgets('me() 404 (server without rider routes) shows "needs an update" with Retry and Sign out',
        (tester) async {
      final server = _Server()
        ..meStatus = 404
        ..meBody = {'error': 'not_found'};
      final h = await _pumpApp(tester, server: server, signedIn: true);

      expect(_location(h), '/needs-update');
      expect(find.text('Deligro\'s server needs an update — try again later.'), findsOneWidget);
      expect(_filled('Retry'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Sign out'), findsOneWidget);
      // Still signed in: a 404 is not an auth failure.
      expect(h.supabase.auth.currentSession, isNotNull);

      // The server is fixed; Retry gets in.
      server
        ..meStatus = 200
        ..meBody = _meBody;
      await tester.tap(_filled('Retry'));
      await _settle(tester);
      expect(_location(h), '/home');
    });

    testWidgets('a network failure keeps the session and offers Retry', (tester) async {
      final server = _Server()..offline = true;
      final h = await _pumpApp(tester, server: server, signedIn: true);

      expect(_location(h), '/gate');
      expect(find.text('No connection. Check your internet and try again.'), findsOneWidget);
      expect(h.supabase.auth.currentSession, isNotNull);

      server.offline = false;
      await tester.tap(_filled('Retry'));
      await _settle(tester);
      expect(_location(h), '/home');
    });
  });

  group('RiderMe', () {
    test('parses the /api/rider/me body', () {
      final me = RiderMe.fromJson(Map<String, dynamic>.from(_meBody));
      expect(me.id, 'rider-1');
      expect(me.name, 'Ravi Kumar');
      expect(me.riderCode, 'DR-0042');
      expect(me.availability.isOnline, false);
      expect(me.phase, 'offline');
      expect(me.activeDeliveryId, isNull);
      expect(me.features['driver.earnings'], false);
      expect(me.features['driver.history'], true);
      expect(me.privacyUrl, 'https://example.com/privacy');
      expect(me.termsUrl, isNull);
    });

    test('a database without rider IDs answers riderCode null', () {
      final me = RiderMe.fromJson({..._meBody, 'riderCode': null, 'name': ''});
      expect(me.riderCode, isNull);
      expect(me.name, '');
    });

    test('a missing switch reads as on (the server only sends false for off)', () {
      final me = RiderMe.fromJson({..._meBody, 'features': <String, dynamic>{}});
      expect(me.features, isEmpty);
      expect(me.feature('driver.history'), true);
    });
  });

  group('RiderRepository request shapes', () {
    late _Server server;
    late RiderRepository repo;

    setUp(() {
      server = _Server();
      final auth = SupabaseClient('http://localhost:1', 'k',
              authOptions: const AuthClientOptions(autoRefreshToken: false))
          .auth;
      repo = RiderRepository(ApiClient(auth, client: MockClient(server.handle)));
    });

    Map<String, dynamic> lastBody(String path) =>
        jsonDecode(server.seen.lastWhere((r) => r.url.path == path).body) as Map<String, dynamic>;

    test('me() GETs /api/rider/me', () async {
      final me = await repo.me();
      expect(server.seen.single.method, 'GET');
      expect(server.seen.single.url.path, '/api/rider/me');
      expect(me.id, 'rider-1');
    });

    test('setStatus posts the action; a break always carries minutes (null = until resumed)', () async {
      await repo.setStatus('online');
      expect(lastBody('/api/rider/status'), {'action': 'online'});

      await repo.setStatus('break', minutes: 30);
      expect(lastBody('/api/rider/status'), {'action': 'break', 'minutes': 30});

      final dto = await repo.setStatus('break');
      expect(lastBody('/api/rider/status'), {'action': 'break', 'minutes': null});
      expect(dto.isOnline, false);
    });

    test('postLocation posts lat/lng and reads online/active', () async {
      final r = await repo.postLocation(21.7, 81.5);
      expect(lastBody('/api/rider/location'), {'lat': 21.7, 'lng': 81.5});
      expect(r.online, true);
      expect(r.active, false);
    });

    test('signoutOffline posts to /api/rider/signout', () async {
      await repo.signoutOffline();
      expect(server.seen.single.method, 'POST');
      expect(server.seen.single.url.path, '/api/rider/signout');
    });

    test('signoutOffline never throws: 503 migration_pending is swallowed (R11)', () async {
      server.signoutStatus = 503;
      await repo.signoutOffline();
      expect(server.count('/api/rider/signout'), 1);
    });

    test('signoutOffline never throws: 401, 500 and a dead network are swallowed (R11)', () async {
      for (final status in [401, 403, 500]) {
        server.signoutStatus = status;
        await repo.signoutOffline();
      }
      server.offline = true;
      await repo.signoutOffline();
    });

    test('other calls still throw ApiException', () async {
      server
        ..meStatus = 403
        ..meBody = {'error': 'not_rider'};
      await expectLater(
        repo.me(),
        throwsA(isA<ApiException>().having((e) => e.status, 'status', 403)),
      );
    });
  });

  group('AuthRepository', () {
    test('signOut(everywhere) uses the global scope; the default is local', () async {
      for (final everywhere in [false, true]) {
        final server = _Server();
        final supabase = _supabase(server);
        await supabase.auth.recoverSession(_sessionJson());
        final repo = AuthRepository(supabase, ApiClient(supabase.auth, client: MockClient(server.handle)));

        await repo.signOut(everywhere: everywhere);

        expect(supabase.auth.currentSession, isNull);
        final logout = server.seen.singleWhere((r) => r.url.path == '/auth/v1/logout');
        expect(logout.url.queryParameters['scope'], everywhere ? 'global' : 'local');
      }
    });

    test('signOut clears the session even when Supabase is unreachable', () async {
      final server = _Server();
      final supabase = _supabase(server);
      await supabase.auth.recoverSession(_sessionJson());
      server.offline = true;
      final repo = AuthRepository(supabase, ApiClient(supabase.auth, client: MockClient(server.handle)));

      await repo.signOut();

      expect(supabase.auth.currentSession, isNull);
    });
  });

  group('login screen layout', () {
    final variants = [
      (Brightness.light, 1.0, 'light'),
      (Brightness.dark, 1.0, 'dark'),
      (Brightness.light, 1.3, 'light, 1.3x text'),
      (Brightness.dark, 1.3, 'dark, 1.3x text'),
    ];
    for (final (brightness, scale, name) in variants) {
      for (final lang in ['en', 'hi']) {
        testWidgets('both tabs render without overflow ($name, $lang)', (tester) async {
          tester.view.physicalSize = const Size(360 * 3, 640 * 3);
          tester.view.devicePixelRatio = 3;
          addTearDown(tester.view.reset);

          final server = _Server();
          final supabase = _supabase(server);
          await tester.pumpWidget(ProviderScope(
            overrides: [
              prefsProvider.overrideWithValue(await _prefs({'lang': lang})),
              supabaseProvider.overrideWithValue(supabase),
              apiProvider.overrideWithValue(ApiClient(supabase.auth, client: MockClient(server.handle))),
            ],
            child: MaterialApp(
              theme: buildTheme(brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: const LoginScreen(),
            ),
          ));
          await _settle(tester);
          expect(tester.takeException(), isNull);
          expect(find.byKey(const Key('phone-field')), findsOneWidget);

          await tester.tap(find.byKey(const Key('tab-email')));
          await tester.pump(const Duration(milliseconds: 400));
          expect(tester.takeException(), isNull);
          expect(find.byKey(const Key('email-field')), findsOneWidget);
          expect(find.byKey(const Key('password-field')), findsOneWidget);

          // With the error banner up, the tallest state.
          await tester.enterText(find.byKey(const Key('email-field')), 'ravi@example.com');
          await tester.enterText(find.byKey(const Key('password-field')), 'x');
          await tester.pump();
          await tester.tap(find.byKey(const Key('email-submit')));
          await _settle(tester);
          expect(tester.takeException(), isNull);
        });
      }
    }
  });
}
