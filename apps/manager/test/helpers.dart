import 'package:deligro_manager/state/prefs.dart';
import 'package:deligro_manager/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// [child] inside the app's theme and a ProviderScope with prefs loaded.
Future<Widget> themed(
  Widget child, {
  List overrides = const [],
  Map<String, Object> prefs = const {},
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  SharedPreferences.setMockInitialValues(prefs);
  final p = await SharedPreferences.getInstance();
  return ProviderScope(
    overrides: [prefsProvider.overrideWithValue(p), ...overrides.cast()],
    child: MaterialApp(theme: buildTheme(Brightness.light), home: child),
  );
}
