// The rider shell: tabs, the Home availability card, More and Settings, the
// update sheet, sign-out and the Privacy & data screen. No network: Supabase
// and the website's API are `MockClient`s (same pattern as auth_test.dart).
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:deligro_rider/config/env.dart';
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/update_check.dart';
import 'package:deligro_rider/data/rider_repository.dart';
import 'package:deligro_rider/router.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

const _breakUntilResumed = '9999-12-31T00:00:00.000Z';

Map<String, dynamic> _avail({
  bool online = false,
  String? breakUntil,
  DateTime? onlineSince,
  DateTime? lastFixAt,
}) => {
  'isOnline': online,
  'breakUntil': breakUntil,
  'onlineSince': onlineSince?.toUtc().toIso8601String(),
  'lastFixAt': lastFixAt?.toUtc().toIso8601String(),
};

/// A fake website + Supabase. Routes by path; every request is recorded.
class _Server {
  final seen = <http.Request>[];

  /// `/api/rider/me`.
  int meStatus = 200;
  Object meError = {'error': 'not_rider'};
  Map<String, dynamic> me = {
    'id': 'rider-1',
    'name': 'Ravi Kumar',
    'phone': '+919876543210',
    'avatarUrl': null,
    'riderCode': 'DR-0042',
    'availability': _avail(),
    'phase': 'offline',
    'activeDeliveryId': null,
    'features': {'driver.history': true, 'driver.earnings': true},
    'legal': {'privacyUrl': null, 'termsUrl': null},
  };

  /// The rider's row on the "server": `/api/rider/status` changes it.
  Map<String, dynamic> get avail => me['availability'] as Map<String, dynamic>;

  /// When set, `/api/rider/status` answers this instead of applying the action.
  (int, Object)? statusOverride;

  /// Fix to report after going online (null = no fix yet, phase "stale").
  DateTime? fixOnOnline;

  /// `/api/rider/signout`: 200 by default; [hangSignout] never answers.
  int signoutStatus = 200;
  Completer<void>? hangSignout;

  /// `/api/app-version`.
  Map<String, dynamic> version = {
    'latestVersionCode': 3,
    'minSupportedVersionCode': 1,
    'updateAvailable': false,
    'forceUpdate': false,
    'apkUrl': '',
    'releaseNotes': '',
  };
  bool versionFails = false;

  /// Throw instead of answering: no connection.
  bool offline = false;

  int count(String path) => seen.where((r) => r.url.path == path).length;

  Map<String, dynamic> lastBody(String path) =>
      jsonDecode(seen.lastWhere((r) => r.url.path == path).body)
          as Map<String, dynamic>;

  (int, Object) _status(Map<String, dynamic> body) {
    final now = DateTime.now();
    switch (body['action']) {
      case 'online':
        me['availability'] = _avail(
          online: true,
          onlineSince: now,
          lastFixAt: fixOnOnline,
        );
      case 'offline':
        me['availability'] = _avail();
      case 'break':
        final minutes = body['minutes'];
        me['availability'] = _avail(
          online: true,
          onlineSince: now,
          lastFixAt: fixOnOnline,
          breakUntil: minutes is int
              ? now.add(Duration(minutes: minutes)).toUtc().toIso8601String()
              : _breakUntilResumed,
        );
      case 'resume':
        me['availability'] = _avail(
          online: true,
          onlineSince: now,
          lastFixAt: fixOnOnline,
        );
    }
    return (200, {'availability': me['availability'], 'phase': 'online'});
  }

  Future<http.Response> handle(http.Request req) async {
    seen.add(req);
    if (offline) throw const SocketException('offline');
    http.Response json(int status, Object body) => http.Response(
      jsonEncode(body),
      status,
      headers: {'content-type': 'application/json'},
    );
    switch (req.url.path) {
      case '/api/rider/me':
        return json(meStatus, meStatus == 200 ? me : meError);
      case '/api/rider/status':
        final (status, body) =
            statusOverride ??
            _status(jsonDecode(req.body) as Map<String, dynamic>);
        return json(status, body);
      case '/api/rider/signout':
        if (hangSignout != null) await hangSignout!.future;
        return json(
          signoutStatus,
          signoutStatus < 300 ? {'ok': true} : {'error': 'migration_pending'},
        );
      case '/api/app-version':
        if (versionFails) return json(500, {'error': 'server_error'});
        return json(200, version);
      case '/auth/v1/logout':
        return http.Response('', 204);
      default:
        return json(404, {'error': 'not_found'});
    }
  }
}

String _sessionJson(String userId) {
  final exp =
      DateTime.now().add(const Duration(hours: 1)).millisecondsSinceEpoch ~/
      1000;
  String b64(Object o) =>
      base64Url.encode(utf8.encode(jsonEncode(o))).replaceAll('=', '');
  final jwt =
      '${b64({'alg': 'HS256'})}.${b64({'sub': userId, 'exp': exp})}.sig';
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

SupabaseClient _supabase(_Server server) {
  final c = SupabaseClient(
    'http://localhost:1',
    'test-key',
    httpClient: MockClient(server.handle),
    authOptions: const AuthClientOptions(autoRefreshToken: false),
  );
  addTearDown(() {
    unawaited(c.dispose());
  });
  return c;
}

/// A repository whose offline hand-off blows up, as a broken build might.
class _ThrowingRepo extends RiderRepository {
  _ThrowingRepo(super.api);

  @override
  Future<void> signoutOffline({
    Duration timeout = const Duration(seconds: 5),
  }) => throw StateError('boom');
}

class _Harness {
  _Harness(this.server, this.supabase, this.container);
  final _Server server;
  final SupabaseClient supabase;
  final ProviderContainer container;
  GoRouterLike get router => GoRouterLike(container);
}

/// Just enough of the router for tests: where it is, and a way to go.
class GoRouterLike {
  GoRouterLike(this._c);
  final ProviderContainer _c;
  String get location => _c.read(routerProvider).state.matchedLocation;
  void go(String path) => _c.read(routerProvider).go(path);
}

Future<_Harness> _pump(
  WidgetTester tester, {
  required _Server server,
  Map<String, Object> prefs = const {},
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  bool signedIn = true,
  bool withUpdateGate = false,
  RiderRepository Function(ApiClient)? repo,
}) async {
  tester.view.physicalSize = const Size(360 * 3, 720 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);

  final supabase = _supabase(server);
  if (signedIn) await supabase.auth.recoverSession(_sessionJson('rider-1'));
  SharedPreferences.setMockInitialValues(prefs);
  final api = ApiClient(supabase.auth, client: MockClient(server.handle));
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      supabaseProvider.overrideWithValue(supabase),
      apiProvider.overrideWithValue(api),
      if (repo != null) riderRepoProvider.overrideWithValue(repo(api)),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: Consumer(
        builder: (context, ref, _) => MaterialApp.router(
          theme: buildTheme(brightness),
          routerConfig: ref.watch(routerProvider),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(textScale)),
            child: withUpdateGate
                ? UpdateGate(navigatorKey: rootNavigatorKey, child: child!)
                : child!,
          ),
        ),
      ),
    ),
  );
  await _settle(tester);
  return _Harness(server, supabase, container);
}

/// Lets futures and route changes finish. Not pumpAndSettle: a spinner on
/// screen never settles.
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

final _chip = find.byKey(const Key('phase-chip'));
Finder _inChip(String text) =>
    find.descendant(of: _chip, matching: find.textContaining(text));
final _switch = find.byKey(const Key('availability-switch'));
final _nav = find.byType(NavigationBar);

Future<void> _openSettings(WidgetTester tester) async {
  await _tap(tester, find.byType(NavigationDestination).last);
  await _tap(tester, find.byKey(const Key('row-settings')));
}

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('tabs', () {
    testWidgets('Home and More, in that order', (tester) async {
      final h = await _pump(tester, server: _Server());
      expect(h.router.location, '/home');
      final labels = find.descendant(of: _nav, matching: find.byType(Text));
      expect(tester.widgetList<Text>(labels).map((t) => t.data).toList(), [
        'Home',
        'More',
      ]);
    });

    testWidgets('More opens, and Settings is its row', (tester) async {
      final h = await _pump(tester, server: _Server());
      await _tap(
        tester,
        find.descendant(of: _nav, matching: find.text('More')),
      );
      expect(h.router.location, '/more');
      await _tap(tester, find.byKey(const Key('row-settings')));
      expect(h.router.location, '/more/settings');
      expect(find.text('Settings'), findsWidgets);
      // The tab bar stays under a More sub-page.
      expect(_nav, findsOneWidget);
    });
  });

  group('Home', () {
    testWidgets('shows the rider name and rider ID', (tester) async {
      await _pump(tester, server: _Server());
      expect(find.text('Ravi Kumar'), findsOneWidget);
      expect(find.text('DR-0042'), findsOneWidget);
    });

    testWidgets('no rider ID yet (null riderCode): shows the name only', (
      tester,
    ) async {
      final server = _Server()..me['riderCode'] = null;
      await _pump(tester, server: server);
      expect(find.text('Ravi Kumar'), findsOneWidget);
      expect(find.textContaining('DR-'), findsNothing);
    });

    testWidgets('offline rider: offline card, Offline chip, no break button', (
      tester,
    ) async {
      await _pump(tester, server: _Server());
      expect(find.text("You're offline"), findsOneWidget);
      expect(_inChip('Offline'), findsOneWidget);
      expect(find.byKey(const Key('break-button')), findsNothing);
    });

    testWidgets(
      'going online calls setStatus(online) and shows "Waiting for location" (no fix yet)',
      (tester) async {
        final server = _Server();
        await _pump(tester, server: server);

        await _tap(tester, _switch);

        expect(server.lastBody('/api/rider/status'), {'action': 'online'});
        expect(find.text("You're online"), findsOneWidget);
        expect(_inChip('Waiting for location'), findsOneWidget);
        expect(find.byKey(const Key('break-button')), findsOneWidget);
      },
    );

    testWidgets(
      'with a recent fix the chip says Online, and time online shows',
      (tester) async {
        final server = _Server()..fixOnOnline = DateTime.now();
        await _pump(tester, server: server);

        await _tap(tester, _switch);

        expect(_inChip('Online'), findsOneWidget);
        expect(_inChip('Waiting'), findsNothing);
        expect(find.textContaining('Time online'), findsOneWidget);
      },
    );

    testWidgets('a rider who loads already online starts on the online card', (
      tester,
    ) async {
      final server = _Server();
      server.me['availability'] = _avail(
        online: true,
        onlineSince: DateTime.now().subtract(const Duration(minutes: 74)),
        lastFixAt: DateTime.now(),
      );
      await _pump(tester, server: server);
      expect(find.text("You're online"), findsOneWidget);
      expect(find.textContaining('1 h 14 min'), findsOneWidget);
    });

    testWidgets('going offline calls setStatus(offline)', (tester) async {
      final server = _Server();
      server.me['availability'] = _avail(
        online: true,
        onlineSince: DateTime.now(),
        lastFixAt: DateTime.now(),
      );
      await _pump(tester, server: server);

      await _tap(tester, _switch);

      expect(server.lastBody('/api/rider/status'), {'action': 'offline'});
      expect(find.text("You're offline"), findsOneWidget);
    });

    testWidgets(
      '409 active_delivery: the snackbar says to finish the order, the switch stays on',
      (tester) async {
        final server = _Server();
        server.me['availability'] = _avail(
          online: true,
          onlineSince: DateTime.now(),
          lastFixAt: DateTime.now(),
        );
        server.statusOverride = (409, {'error': 'active_delivery'});
        await _pump(tester, server: server);

        await _tap(tester, _switch);

        expect(
          find.text('Finish or hand back your current order first.'),
          findsOneWidget,
        );
        expect(find.text("You're online"), findsOneWidget);
      },
    );

    testWidgets(
      '503 migration_pending: a calm message, the switch stays off, no crash',
      (tester) async {
        final server = _Server()
          ..statusOverride = (503, {'error': 'migration_pending'});
        await _pump(tester, server: server);

        await _tap(tester, _switch);

        expect(
          find.text("Online status isn't available yet — Deligro is updating."),
          findsOneWidget,
        );
        expect(find.text("You're offline"), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('no connection: the network message, the switch stays off', (
      tester,
    ) async {
      final server = _Server();
      await _pump(tester, server: server);
      server.offline = true;

      await _tap(tester, _switch);

      expect(
        find.text('No connection. Check your internet and try again.'),
        findsOneWidget,
      );
      expect(find.text("You're offline"), findsOneWidget);
    });

    testWidgets('break 30 sends minutes 30 and shows "On break until"', (
      tester,
    ) async {
      final server = _Server()..fixOnOnline = DateTime.now();
      await _pump(tester, server: server);
      await _tap(tester, _switch);

      await _tap(tester, find.byKey(const Key('break-button')));
      await _tap(tester, find.byKey(const Key('break-30')));

      expect(server.lastBody('/api/rider/status'), {
        'action': 'break',
        'minutes': 30,
      });
      expect(_inChip('On break until'), findsOneWidget);
      expect(find.byKey(const Key('resume-button')), findsOneWidget);
    });

    testWidgets(
      'break until I resume sends minutes null and never shows a date (R4)',
      (tester) async {
        final server = _Server()..fixOnOnline = DateTime.now();
        await _pump(tester, server: server);
        await _tap(tester, _switch);

        await _tap(tester, find.byKey(const Key('break-button')));
        await _tap(tester, find.byKey(const Key('break-until-resume')));

        expect(server.lastBody('/api/rider/status'), {
          'action': 'break',
          'minutes': null,
        });
        expect(_inChip('Until you resume'), findsOneWidget);
        expect(find.textContaining('9999'), findsNothing);
        expect(find.textContaining('Dec'), findsNothing);
      },
    );

    testWidgets('Resume ends the break', (tester) async {
      final server = _Server()..fixOnOnline = DateTime.now();
      await _pump(tester, server: server);
      await _tap(tester, _switch);
      await _tap(tester, find.byKey(const Key('break-button')));
      await _tap(tester, find.byKey(const Key('break-15')));

      await _tap(tester, find.byKey(const Key('resume-button')));

      expect(server.lastBody('/api/rider/status'), {'action': 'resume'});
      expect(_inChip('On break'), findsNothing);
      expect(find.byKey(const Key('break-button')), findsOneWidget);
    });

    testWidgets(
      'a network error on a refresh keeps the rider on /home with an offline banner (R15)',
      (tester) async {
        final server = _Server();
        final h = await _pump(tester, server: server);
        expect(h.router.location, '/home');
        expect(
          find.textContaining("You're offline — showing your last status"),
          findsNothing,
        );

        server.offline = true;
        h.container.invalidate(meProvider);
        await _settle(tester);

        expect(h.router.location, '/home');
        expect(find.text('Ravi Kumar'), findsOneWidget);
        expect(
          find.text("You're offline — showing your last status"),
          findsOneWidget,
        );

        // Back online, the banner's Retry clears it.
        server.offline = false;
        await _tap(tester, find.byKey(const Key('offline-retry')));
        expect(h.router.location, '/home');
        expect(find.textContaining('showing your last status'), findsNothing);
      },
    );

    testWidgets('a 403 on a refresh still goes to /not-rider (R15)', (
      tester,
    ) async {
      final server = _Server();
      final h = await _pump(tester, server: server);
      expect(h.router.location, '/home');

      server.meStatus = 403;
      h.container.invalidate(meProvider);
      await _settle(tester);

      expect(h.router.location, '/not-rider');
    });

    testWidgets('a 503 on a refresh still goes to /needs-update (R15)', (
      tester,
    ) async {
      final server = _Server();
      final h = await _pump(tester, server: server);
      server
        ..meStatus = 503
        ..meError = {'error': 'not_configured'};
      h.container.invalidate(meProvider);
      await _settle(tester);
      expect(h.router.location, '/needs-update');
    });

    testWidgets(
      "rider A signs out, rider B signs in and /me fails with no connection: /gate, never A's value on /home (R15 edge)",
      (tester) async {
        final server = _Server();
        final h = await _pump(tester, server: server);
        expect(h.router.location, '/home');
        expect(find.text('Ravi Kumar'), findsOneWidget);

        await h.supabase.auth.signOut();
        await _settle(tester);
        expect(h.router.location, '/login');

        server.offline = true;
        await h.supabase.auth.recoverSession(_sessionJson('rider-b'));
        // Every frame from here on must be free of A.
        for (var i = 0; i < 8; i++) {
          await tester.runAsync(
            () => Future<void>.delayed(const Duration(milliseconds: 10)),
          );
          await tester.pump(const Duration(milliseconds: 60));
          expect(find.text('Ravi Kumar'), findsNothing, reason: 'frame $i');
          expect(find.text('DR-0042'), findsNothing, reason: 'frame $i');
          expect(
            find.textContaining("showing your last status"),
            findsNothing,
            reason: 'frame $i',
          );
          expect(h.router.location, isNot('/home'), reason: 'frame $i');
        }

        expect(h.supabase.auth.currentUser?.id, 'rider-b');
        expect(h.router.location, '/gate');
      },
    );

    testWidgets(
      'a network error before anything loaded is still the /gate with Retry (R15 boundary)',
      (tester) async {
        final server = _Server()..offline = true;
        final h = await _pump(tester, server: server);
        expect(h.router.location, '/gate');
      },
    );
  });

  group('Settings', () {
    testWidgets('shows the app version and has no language setting', (
      tester,
    ) async {
      await _pump(tester, server: _Server());
      await _openSettings(tester);
      expect(find.text('2.0.0 (3)'), findsOneWidget);
      expect(find.text('Language'), findsNothing);
      expect(find.text('English'), findsNothing);
    });

    test('Env.versionName matches pubspec', () {
      final line = File('pubspec.yaml')
          .readAsLinesSync()
          .firstWhere((l) => l.startsWith('version:'));
      expect(line, 'version: ${Env.versionName}+${Env.versionCode}');
    });

    testWidgets('Check for updates: up to date says so', (tester) async {
      final server = _Server();
      await _pump(tester, server: server);
      await _openSettings(tester);

      await _tap(tester, find.byKey(const Key('row-check-updates')));

      expect(
        server.seen
            .where((r) => r.url.path == '/api/app-version')
            .last
            .url
            .queryParameters,
        {'app': 'rider', 'versionCode': '3'},
      );
      expect(find.text("You're on the latest version."), findsOneWidget);
    });

    testWidgets(
      'Check for updates: a newer build opens the update sheet with notes and a download button',
      (tester) async {
        final server = _Server()
          ..version = {
            'latestVersionCode': 4,
            'minSupportedVersionCode': 1,
            'updateAvailable': true,
            'forceUpdate': false,
            'apkUrl': 'https://example.com/rider.apk',
            'releaseNotes': 'Faster break menu.',
          };
        await _pump(tester, server: server);
        await _openSettings(tester);

        await _tap(tester, find.byKey(const Key('row-check-updates')));

        expect(find.text('Update available'), findsOneWidget);
        expect(find.text('Faster break menu.'), findsOneWidget);
        expect(find.byKey(const Key('update-download')), findsOneWidget);
        await _tap(tester, find.byKey(const Key('update-later')));
        expect(find.text('Update available'), findsNothing);
      },
    );

    testWidgets('Check for updates: a failed check says so, no crash', (
      tester,
    ) async {
      final server = _Server()..versionFails = true;
      await _pump(tester, server: server);
      await _openSettings(tester);
      await _tap(tester, find.byKey(const Key('row-check-updates')));
      expect(
        find.text("Couldn't check for updates. Try again."),
        findsOneWidget,
      );
    });
  });

  group('update gate', () {
    testWidgets(
      'forceUpdate blocks the app with a sheet that cannot be dismissed',
      (tester) async {
        final server = _Server()
          ..version = {
            'latestVersionCode': 4,
            'minSupportedVersionCode': 4,
            'updateAvailable': true,
            'forceUpdate': true,
            'apkUrl': 'https://example.com/rider.apk',
            'releaseNotes': 'Required fix.',
          };
        await _pump(tester, server: server, withUpdateGate: true);

        expect(find.text('Update required'), findsOneWidget);
        expect(find.text('Required fix.'), findsOneWidget);
        expect(find.byKey(const Key('update-download')), findsOneWidget);
        expect(find.byKey(const Key('update-later')), findsNothing);
        // The app underneath is not on screen at all.
        expect(_switch, findsNothing);
        expect(server.count('/api/rider/status'), 0);
      },
    );

    Future<_Harness> pumpBlocked(
      WidgetTester tester, {
      bool signedIn = true,
    }) async {
      final server = _Server()
        ..version = {
          'latestVersionCode': 4,
          'minSupportedVersionCode': 4,
          'updateAvailable': true,
          'forceUpdate': true,
          'apkUrl': 'https://example.com/rider.apk',
          'releaseNotes': 'Required fix.',
        };
      return _pump(
        tester,
        server: server,
        withUpdateGate: true,
        signedIn: signedIn,
      );
    }

    testWidgets('Android Back neither pops nor leaves the app while blocked', (
      tester,
    ) async {
      final h = await pumpBlocked(tester);
      expect(h.router.location, updateRequiredPath);

      final calls = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          calls.add(call.method);
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );

      await tester.binding.handlePopRoute();
      await _settle(tester);

      expect(calls, isNot(contains('SystemNavigator.pop')));
      expect(h.router.location, updateRequiredPath);
      expect(find.text('Update required'), findsOneWidget);
    });

    testWidgets('deep links and router.go cannot leave the update screen', (
      tester,
    ) async {
      final h = await pumpBlocked(tester);
      for (final path in [
        '/home',
        '/more/settings',
        '/more/privacy',
        '/login',
      ]) {
        h.router.go(path);
        await _settle(tester);
        expect(h.router.location, updateRequiredPath, reason: path);
        expect(find.text('Update required'), findsOneWidget, reason: path);
      }
    });

    testWidgets('signed out, the update screen still comes first', (
      tester,
    ) async {
      final h = await pumpBlocked(tester, signedIn: false);
      expect(h.router.location, updateRequiredPath);
      expect(find.text('Update required'), findsOneWidget);
    });

    testWidgets(
      'while blocked the app underneath is not in the semantics tree',
      (tester) async {
        final semantics = tester.ensureSemantics();
  
        // Control: unblocked, the availability switch is reachable by TalkBack.
        await _pump(tester, server: _Server());
        expect(find.bySemanticsLabel(RegExp('Go online')), findsOneWidget);

        await pumpBlocked(tester);
        expect(find.bySemanticsLabel(RegExp('Go online')), findsNothing);
        expect(find.bySemanticsLabel(RegExp('Go offline')), findsNothing);
        expect(find.bySemanticsLabel(RegExp(r'^Update$')), findsOneWidget);
        semantics.dispose();
      },
    );

    testWidgets('once the update is no longer forced the app comes back', (
      tester,
    ) async {
      final h = await pumpBlocked(tester);
      expect(h.router.location, updateRequiredPath);

      h.server.version = {
        ...h.server.version,
        'forceUpdate': false,
        'updateAvailable': false,
      };
      h.container.invalidate(updateProvider);
      await _settle(tester);

      expect(h.router.location, '/home');
      expect(_switch, findsOneWidget);
    });

    testWidgets(
      'forceUpdate with no download link still blocks and says to ask Deligro',
      (tester) async {
        final server = _Server()
          ..version = {
            'latestVersionCode': 4,
            'minSupportedVersionCode': 4,
            'updateAvailable': true,
            'forceUpdate': true,
            'apkUrl': '',
            'releaseNotes': '',
          };
        await _pump(tester, server: server, withUpdateGate: true);
        expect(find.text('Update required'), findsOneWidget);
        expect(find.byKey(const Key('update-download')), findsNothing);
        expect(find.textContaining('Ask Deligro'), findsOneWidget);
      },
    );

    testWidgets('an optional update is offered once, with Later', (
      tester,
    ) async {
      final server = _Server()
        ..version = {
          'latestVersionCode': 4,
          'minSupportedVersionCode': 1,
          'updateAvailable': true,
          'forceUpdate': false,
          'apkUrl': 'https://example.com/rider.apk',
          'releaseNotes': '',
        };
      await _pump(tester, server: server, withUpdateGate: true);

      expect(find.text('Update available'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('update-later')));
      expect(find.text('Update available'), findsNothing);
      expect(find.byKey(const Key('update-later')), findsNothing);
    });

    testWidgets('no update, or a failed check, shows nothing', (tester) async {
      await _pump(tester, server: _Server(), withUpdateGate: true);
      expect(find.text('Update available'), findsNothing);
      expect(find.text('Update required'), findsNothing);
      await _pump(
        tester,
        server: _Server()..versionFails = true,
        withUpdateGate: true,
      );
      expect(find.text('Update required'), findsNothing);
    });
  });

  group('sign out', () {
    Future<void> signOutRow(WidgetTester tester, String key) async {
      await _tap(tester, find.byKey(Key(key)));
    }

    testWidgets(
      'signs out: offline hand-off first, then the session ends and /login shows',
      (tester) async {
        final server = _Server();
        final h = await _pump(tester, server: server);
        await _openSettings(tester);

        await signOutRow(tester, 'row-signout');

        expect(server.count('/api/rider/signout'), 1);
        expect(h.supabase.auth.currentSession, isNull);
        expect(h.router.location, '/login');
        final logout = server.seen.singleWhere(
          (r) => r.url.path == '/auth/v1/logout',
        );
        expect(logout.url.queryParameters['scope'], 'local');
      },
    );

    testWidgets('sign out of all devices uses the global scope', (
      tester,
    ) async {
      final server = _Server();
      final h = await _pump(tester, server: server);
      await _openSettings(tester);

      await signOutRow(tester, 'row-signout-all');

      expect(server.count('/api/rider/signout'), 1);
      final logout = server.seen.singleWhere(
        (r) => r.url.path == '/auth/v1/logout',
      );
      expect(logout.url.queryParameters['scope'], 'global');
      expect(h.router.location, '/login');
    });

    testWidgets('a throwing signoutOffline never blocks signOut (R11)', (
      tester,
    ) async {
      final server = _Server();
      final h = await _pump(tester, server: server, repo: _ThrowingRepo.new);
      await _openSettings(tester);

      await signOutRow(tester, 'row-signout');

      expect(h.supabase.auth.currentSession, isNull);
      expect(h.router.location, '/login');
    });

    testWidgets('a failing offline hand-off (503) still signs out', (
      tester,
    ) async {
      final server = _Server()..signoutStatus = 503;
      final h = await _pump(tester, server: server);
      await _openSettings(tester);
      await signOutRow(tester, 'row-signout');
      expect(h.supabase.auth.currentSession, isNull);
    });

    testWidgets(
      'a hanging offline hand-off gives up after 5 s, with progress shown meanwhile',
      (tester) async {
        final server = _Server()..hangSignout = Completer<void>();
        final h = await _pump(tester, server: server);
        await _openSettings(tester);

        await tester.ensureVisible(find.byKey(const Key('row-signout')));
        await tester.tap(find.byKey(const Key('row-signout')));
        await tester.pump(const Duration(seconds: 2));

        // Still waiting: progress on the row, session intact.
        expect(find.byKey(const Key('signout-progress')), findsOneWidget);
        expect(h.supabase.auth.currentSession, isNotNull);

        await tester.pump(const Duration(seconds: 4));
        await _settle(tester);

        expect(h.supabase.auth.currentSession, isNull);
        expect(h.router.location, '/login');
        server.hangSignout!.complete();
      },
    );

    testWidgets(
      'while carrying an order, a confirm dialog appears; Cancel keeps the session',
      (tester) async {
        final server = _Server();
        server.me['activeDeliveryId'] = 'd-1';
        final h = await _pump(tester, server: server);
        await _openSettings(tester);

        await signOutRow(tester, 'row-signout');

        expect(
          find.text("You're carrying an order. Sign out anyway?"),
          findsOneWidget,
        );
        expect(server.count('/api/rider/signout'), 0);

        await _tap(tester, find.byKey(const Key('confirm-cancel')));
        expect(
          find.text("You're carrying an order. Sign out anyway?"),
          findsNothing,
        );
        expect(h.supabase.auth.currentSession, isNotNull);
        expect(server.count('/api/rider/signout'), 0);
      },
    );

    testWidgets('confirming the dialog signs out', (tester) async {
      final server = _Server();
      server.me['activeDeliveryId'] = 'd-1';
      final h = await _pump(tester, server: server);
      await _openSettings(tester);

      await signOutRow(tester, 'row-signout-all');
      await _tap(tester, find.byKey(const Key('confirm-ok')));

      expect(h.supabase.auth.currentSession, isNull);
      expect(h.router.location, '/login');
    });

    test('RiderRepository.signoutOffline gives up after its timeout and never throws', () async {
      final server = _Server()..hangSignout = Completer<void>();
      final auth = SupabaseClient(
        'http://localhost:1',
        'k',
        authOptions: const AuthClientOptions(autoRefreshToken: false),
      ).auth;
      final repo = RiderRepository(
        ApiClient(auth, client: MockClient(server.handle)),
      );

      final watch = Stopwatch()..start();
      await repo.signoutOffline(timeout: const Duration(milliseconds: 80));
      expect(watch.elapsed, lessThan(const Duration(seconds: 3)));
      server.hangSignout!.complete();
    });
  });

  group('Privacy & data', () {
    Future<void> openPrivacy(WidgetTester tester) async {
      await _openSettings(tester);
      await _tap(tester, find.byKey(const Key('row-privacy')));
    }

    testWidgets(
      'lists what the app holds, and hides policy and terms when no URL is set',
      (tester) async {
        final h = await _pump(tester, server: _Server());
        await openPrivacy(tester);

        expect(h.router.location, '/more/privacy');
        for (final t in [
          'Your phone number',
          'Your name and photo',
          'Your location',
          'Delivery records',
          'Earnings and cash records',
          'Documents',
        ]) {
          await tester.ensureVisible(find.text(t));
          expect(find.text(t), findsOneWidget, reason: t);
        }
        expect(find.text('Privacy policy'), findsNothing);
        expect(find.text('Terms'), findsNothing);
      },
    );

    testWidgets('shows the policy row only when its URL is set', (
      tester,
    ) async {
      final server = _Server();
      server.me['legal'] = {
        'privacyUrl': 'https://example.com/privacy',
        'termsUrl': null,
      };
      await _pump(tester, server: server);
      await openPrivacy(tester);
      await tester.ensureVisible(find.text('Your phone number'));
      expect(find.text('Privacy policy'), findsOneWidget);
      expect(find.text('Terms'), findsNothing);
    });

    testWidgets('shows both when both are set', (tester) async {
      final server = _Server();
      server.me['legal'] = {
        'privacyUrl': 'https://example.com/privacy',
        'termsUrl': 'https://example.com/terms',
      };
      await _pump(tester, server: server);
      await openPrivacy(tester);
      expect(find.text('Privacy policy'), findsOneWidget);
      expect(find.text('Terms'), findsOneWidget);
    });
  });

  group('every screen renders without exceptions', () {
    final variants = [
      (Brightness.light, 1.0, 'light'),
      (Brightness.dark, 1.0, 'dark'),
      (Brightness.light, 1.3, 'light, 1.3x text'),
      (Brightness.dark, 1.3, 'dark, 1.3x text'),
    ];
    for (final (brightness, scale, name) in variants) {
      {
        testWidgets(
          'Home (offline, online, break), More, Settings, Privacy ($name)',
          (tester) async {
            final server = _Server();
            server.me['legal'] = {
              'privacyUrl': 'https://example.com/privacy',
              'termsUrl': 'https://example.com/terms',
            };
            server.me['activeDeliveryId'] = 'd-1';
            final h = await _pump(
              tester,
              server: server,
              brightness: brightness,
              textScale: scale,
            );
            expect(tester.takeException(), isNull, reason: 'Home offline');

            await _tap(tester, _switch);
            expect(tester.takeException(), isNull, reason: 'Home online');
            await _tap(tester, find.byKey(const Key('break-button')));
            expect(tester.takeException(), isNull, reason: 'break menu');
            await _tap(tester, find.byKey(const Key('break-until-resume')));
            expect(tester.takeException(), isNull, reason: 'Home on break');

            // The offline banner on top of Home.
            server.offline = true;
            h.container.invalidate(meProvider);
            await _settle(tester);
            expect(tester.takeException(), isNull, reason: 'offline banner');
            server.offline = false;

            h.router.go('/more');
            await _settle(tester);
            expect(tester.takeException(), isNull, reason: 'More');
            h.router.go('/more/settings');
            await _settle(tester);
            expect(tester.takeException(), isNull, reason: 'Settings');
            h.router.go('/more/privacy');
            await _settle(tester);
            expect(tester.takeException(), isNull, reason: 'Privacy');
          },
        );
      }
    }

    testWidgets('the blocking update sheet renders at 1.3x in dark', (
      tester,
    ) async {
      final server = _Server()
        ..version = {
          'latestVersionCode': 4,
          'minSupportedVersionCode': 4,
          'updateAvailable': true,
          'forceUpdate': true,
          'apkUrl': 'https://example.com/rider.apk',
          'releaseNotes': 'A long note ' * 30,
        };
      await _pump(
        tester,
        server: server,
        brightness: Brightness.dark,
        textScale: 1.3,
        withUpdateGate: true,
      );
      expect(tester.takeException(), isNull);
      expect(find.text('Update required'), findsOneWidget);
    });
  });
}
