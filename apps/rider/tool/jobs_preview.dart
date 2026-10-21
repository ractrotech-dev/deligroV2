// A debug-only way to see the Jobs tab on a phone or emulator without a server
// or a signed-in rider: the real screen and theme over the fixture backend.
//
//   flutter run -t tool/jobs_preview.dart --dart-define=FIXTURES=true
//     [--dart-define=FIXTURE_SCENARIO=offers|idle|full|accepted|...]
//     [--dart-define=PREVIEW_OFFLINE=true]   the rider is offline
//     [--dart-define=PREVIEW_DARK=true]
//
// Not part of the app: nothing imports this file, and a release build refuses
// the fixture backend anyway.
import 'package:deligro_rider/core/ring.dart';
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/features/jobs/jobs_screen.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _offline = bool.fromEnvironment('PREVIEW_OFFLINE');
const _dark = bool.fromEnvironment('PREVIEW_DARK');

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (!fixturesEnabled) {
    throw StateError('run with --dart-define=FIXTURES=true in a debug or profile build');
  }
  final prefs = await SharedPreferences.getInstance();
  final now = DateTime.now();
  runApp(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      ringChannelProvider.overrideWithValue(RingChannel()),
      meProvider.overrideWith(
        (_) async => RiderMe(
          id: 'preview',
          name: 'Ravi Kumar',
          availability: RiderAvailabilityDto(
            isOnline: !_offline,
            onlineSince: _offline ? null : now,
            lastFixAt: _offline ? null : now,
          ),
          phase: _offline ? 'offline' : 'online',
        ),
      ),
    ],
    child: MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: _dark ? ThemeMode.dark : ThemeMode.light,
      home: const JobsScreen(),
    ),
  ));
}
