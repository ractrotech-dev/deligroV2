// A debug-only way to see the Cash screens on a phone or emulator without a
// server or a signed-in rider: the real shell, screens and theme over the
// fixture cash backend.
//
//   flutter run -t tool/cash_preview.dart --dart-define=FIXTURES=true
//     [--dart-define=FIXTURE_CASH=holding|fine|empty|off]
//     [--dart-define=PREVIEW_ROUTE=/more/cash/collections]   where to start
//     [--dart-define=PREVIEW_DARK=true]
//     [--dart-define=PREVIEW_SHEET=deposit|dispute]   open a sheet on start
//
// Not part of the app: nothing imports this file, and a release build refuses
// the fixture backend anyway.
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/features/cash/deposit_sheet.dart';
import 'package:deligro_rider/features/cash/dispute_sheet.dart';
import 'package:deligro_rider/features/shell/rider_shell.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

final _navigator = GlobalKey<NavigatorState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (!fixturesEnabled) {
    throw StateError(
      'run with --dart-define=FIXTURES=true in a debug or profile build',
    );
  }
  final prefs = await SharedPreferences.getInstance();
  const route = String.fromEnvironment(
    'PREVIEW_ROUTE',
    defaultValue: '/more/cash',
  );
  const dark = bool.fromEnvironment('PREVIEW_DARK');
  const sheet = String.fromEnvironment('PREVIEW_SHEET');
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      // The cash providers are keyed to the signed-in user; there is no
      // Supabase session in a preview.
      userIdProvider.overrideWithValue('preview'),
      meProvider.overrideWith(
        (_) async => RiderMe(
          id: 'preview',
          name: 'Ravi Kumar',
          riderCode: 'DR-0042',
          availability: RiderAvailabilityDto(
            isOnline: true,
            onlineSince: DateTime.now(),
            lastFixAt: DateTime.now(),
          ),
          phase: 'online',
        ),
      ),
    ],
  );
  final router = GoRouter(
    navigatorKey: _navigator,
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
        themeMode: dark ? ThemeMode.dark : ThemeMode.system,
        routerConfig: router,
      ),
    ),
  );
  if (sheet.isNotEmpty) {
    await Future<void>.delayed(const Duration(seconds: 3));
    final context = _navigator.currentContext;
    if (context != null && context.mounted) {
      if (sheet == 'deposit') {
        await showDepositSheet(context, available: 4400);
      } else {
        final today = DateTime.now().subtract(const Duration(days: 1));
        final day =
            '${today.year}-${today.month.toString().padLeft(2, '0')}-${today.day.toString().padLeft(2, '0')}';
        await showDisputeSheet(context, day: day);
      }
    }
  }
}
