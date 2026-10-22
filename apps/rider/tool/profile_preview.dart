// A debug-only way to see Profile & documents on a phone or emulator without a
// server or a signed-in rider: the real shell, screens and theme over the
// fixture profile backend.
//
//   flutter run -t tool/profile_preview.dart --dart-define=FIXTURES=true
//     [--dart-define=FIXTURE_PROFILE=mixed|verified|new]
//     [--dart-define=PREVIEW_ROUTE=/more/profile/documents]   where to start
//     [--dart-define=PREVIEW_DARK=true]
//
// "Choose a file" and "Take a photo" hand the upload screen a made-up 1.8 MB
// JPEG, so the picked-file state can be seen without a camera or file browser.
//
// Not part of the app: nothing imports this file, and a release build refuses
// the fixture backend anyway.
import 'dart:typed_data';

import 'package:deligro_rider/core/document_file.dart';
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/features/shell/rider_shell.dart';
import 'package:deligro_rider/models/profile.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/profile.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (!fixturesEnabled) {
    throw StateError('run with --dart-define=FIXTURES=true in a debug or profile build');
  }
  final prefs = await SharedPreferences.getInstance();
  const route = String.fromEnvironment('PREVIEW_ROUTE', defaultValue: '/more/profile');
  const dark = bool.fromEnvironment('PREVIEW_DARK');
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      documentChooserProvider.overrideWithValue(
        (source) async => PickedDocument(
          path: '/preview/licence-front.jpg',
          name: 'licence-front.jpg',
          size: 1800 * 1024,
          head: Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0]),
        ),
      ),
      meProvider.overrideWith(
        (_) async => RiderMe(
          id: 'preview',
          name: 'Ravi Kumar',
          riderCode: 'DR-0042',
          availability: RiderAvailabilityDto(isOnline: true, onlineSince: DateTime.now(), lastFixAt: DateTime.now()),
          phase: 'online',
          profile: const ProfileStatus(verification: Verification.pending, needsAttention: true),
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
        themeMode: dark ? ThemeMode.dark : ThemeMode.system,
        routerConfig: router,
      ),
    ),
  );
}
