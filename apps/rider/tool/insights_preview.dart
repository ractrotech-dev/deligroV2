// A debug-only way to see Home, History and Performance on a phone or
// emulator without a server or a signed-in rider: the real shell, screens and
// theme over the fixture insights backend.
//
//   flutter run -t tool/insights_preview.dart --dart-define=FIXTURES=true
//     [--dart-define=FIXTURE_INSIGHTS=busy|empty|off]
//     [--dart-define=PREVIEW_ROUTE=/history]   where to start
//     [--dart-define=PREVIEW_DARK=true]
//
// Not part of the app: nothing imports this file, and a release build refuses
// the fixture backend anyway.
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/data/fixtures/fixture_insights.dart';
import 'package:deligro_rider/features/shell/rider_shell.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (!fixturesEnabled) {
    throw StateError(
      'run with --dart-define=FIXTURES=true in a debug or profile build',
    );
  }
  final prefs = await SharedPreferences.getInstance();
  const route = String.fromEnvironment('PREVIEW_ROUTE', defaultValue: '/home');
  const dark = bool.fromEnvironment('PREVIEW_DARK');
  final money = fixtureInsightsScenario != 'off';
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      meProvider.overrideWith(
        (_) async => RiderMe(
          id: 'preview',
          name: 'Ravi Kumar',
          riderCode: 'DR-0042',
          availability: RiderAvailabilityDto(
            isOnline: fixtureInsightsScenario != 'empty',
            onlineSince: DateTime.now(),
            lastFixAt: DateTime.now(),
          ),
          phase: fixtureInsightsScenario == 'empty' ? 'offline' : 'online',
          features: {'driver.earnings': money},
        ),
      ),
    ],
  );
  final router = GoRouter(
    initialLocation: route,
    routes: [
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => RiderShell(shell: shell),
        branches: [
          for (final tab in riderTabs) StatefulShellBranch(routes: [tab.route]),
        ],
      ),
    ],
  );
  runApp(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        debugShowCheckedModeBanner: false,
        theme: buildTheme(Brightness.light),
        darkTheme: buildTheme(Brightness.dark),
        themeMode: dark ? ThemeMode.dark : ThemeMode.light,
        routerConfig: router,
      ),
    ),
  );
}
