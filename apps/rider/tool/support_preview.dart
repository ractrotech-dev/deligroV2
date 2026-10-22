// A debug-only way to see Help, the notification inbox, Safety and the SOS
// sheet on a phone or emulator without a server or a signed-in rider: the real
// shell, screens and theme over the fixture backends.
//
//   flutter build apk --debug -t tool/support_preview.dart --dart-define=FIXTURES=true
//     [--dart-define=PREVIEW_DARK=true]
//
// The page to open is the Android intent's initial route:
//
//   adb shell am start -n <package>/.MainActivity --es route /more/help
//
// Routes are the app's own (/more/help, /more/help/new, /more/help/tickets/<id>,
// /notifications, /safety, /safety/report) plus three that open the SOS sheet
// over More: /sos-open (idle), /sos-sent (Alert Deligro pressed, server
// confirms) and /sos-queued (pressed, server cannot be reached).
//
// Not part of the app: nothing imports this file, and a release build refuses
// the fixture backend anyway.
import 'dart:ui';

import 'package:deligro_rider/core/location_service.dart';
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/data/fixtures/fixture_support.dart';
import 'package:deligro_rider/features/notifications/notifications_screen.dart';
import 'package:deligro_rider/features/safety/safety_screen.dart';
import 'package:deligro_rider/features/safety/sos_sheet.dart';
import 'package:deligro_rider/features/shell/rider_shell.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/state/safety.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

final _navigator = GlobalKey<NavigatorState>();

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (!fixturesEnabled) {
    throw StateError('run with --dart-define=FIXTURES=true in a debug or profile build');
  }
  final prefs = await SharedPreferences.getInstance();
  const dark = bool.fromEnvironment('PREVIEW_DARK');
  var route = PlatformDispatcher.instance.defaultRouteName;
  if (route == '/' || route.isEmpty) route = '/more/help';
  final sosMode = switch (route) {
    '/sos-open' => 'open',
    '/sos-sent' => 'sent',
    '/sos-queued' => 'queued',
    _ => null,
  };
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      userIdProvider.overrideWithValue('preview'),
      if (sosMode == 'queued')
        safetyRepoProvider.overrideWithValue(FixtureSafetyRepository.create(scenario: 'offline')),
      meProvider.overrideWith(
        (_) async => RiderMe(
          id: 'preview',
          name: 'Ravi Kumar',
          riderCode: 'DR-0042',
          availability: RiderAvailabilityDto(isOnline: true, onlineSince: DateTime.now(), lastFixAt: DateTime.now()),
          phase: 'online',
        ),
      ),
    ],
  );
  container.read(latestFixProvider.notifier).set((lat: 21.7189, lng: 81.5301, at: DateTime.now()));
  final router = GoRouter(
    navigatorKey: _navigator,
    initialLocation: sosMode != null ? '/more' : route,
    routes: [
      // The SOS modes start on More; the sheet is opened over it below.
      for (final p in ['/sos-open', '/sos-sent', '/sos-queued'])
        GoRoute(path: p, redirect: (_, _) => '/more'),
      notificationsRoute,
      safetyRoute,
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => RiderShell(shell: shell),
        branches: [
          for (final tab in riderTabs) StatefulShellBranch(routes: [tab.route]),
        ],
      ),
    ],
  );
  if (sosMode != null) {
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      await Future<void>.delayed(const Duration(milliseconds: 800));
      final context = _navigator.currentContext;
      if (context == null) return;
      if (!context.mounted) return;
      showSosSheet(context);
      if (sosMode == 'open') return;
      await Future<void>.delayed(const Duration(seconds: 2));
      await container.read(sosQueueProvider).alert(lat: 21.7189, lng: 81.5301);
    });
  }
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
}
