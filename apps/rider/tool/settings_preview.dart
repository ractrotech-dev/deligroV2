// A debug-only way to see the Settings screen on a phone or emulator without a
// server or a signed-in rider: the real screen and theme, the real ring service
// behind "Test the alert".
//
//   flutter run -t tool/settings_preview.dart [--dart-define=PREVIEW_DARK=true]
//
// Not part of the app: nothing imports this file.
import 'package:deligro_rider/features/settings/settings_screen.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  const dark = bool.fromEnvironment('PREVIEW_DARK');
  runApp(
    ProviderScope(
      overrides: [prefsProvider.overrideWithValue(prefs)],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildTheme(dark ? Brightness.dark : Brightness.light),
        home: const SettingsScreen(),
      ),
    ),
  );
}
