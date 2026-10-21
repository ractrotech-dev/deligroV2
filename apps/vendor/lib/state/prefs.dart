import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Overridden in main() with the loaded instance.
final prefsProvider = Provider<SharedPreferences>((_) => throw UnimplementedError('prefsProvider must be overridden'));

class ThemeModeNotifier extends Notifier<ThemeMode> {
  static const _key = 'partner-theme';

  @override
  ThemeMode build() => switch (ref.read(prefsProvider).getString(_key)) {
    'light' => ThemeMode.light,
    'dark' => ThemeMode.dark,
    _ => ThemeMode.system,
  };

  void set(ThemeMode mode) {
    state = mode;
    ref.read(prefsProvider).setString(_key, mode.name);
  }
}

final themeModeProvider = NotifierProvider<ThemeModeNotifier, ThemeMode>(ThemeModeNotifier.new);
