import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Overridden in main() with the loaded instance.
final prefsProvider = Provider<SharedPreferences>(
  (_) => throw UnimplementedError('prefsProvider must be overridden'),
);

class ThemeModeNotifier extends Notifier<ThemeMode> {
  static const _key = 'manager-theme';

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

final themeModeProvider =
    NotifierProvider<ThemeModeNotifier, ThemeMode>(ThemeModeNotifier.new);

/// The zone every screen is filtered to: null = "All my zones".
class ZoneFilterNotifier extends Notifier<String?> {
  static const _key = 'manager-zone';

  @override
  String? build() => ref.read(prefsProvider).getString(_key);

  void set(String? zoneId) {
    state = zoneId;
    final prefs = ref.read(prefsProvider);
    if (zoneId == null) {
      prefs.remove(_key);
    } else {
      prefs.setString(_key, zoneId);
    }
  }
}

final zoneFilterProvider =
    NotifierProvider<ZoneFilterNotifier, String?>(ZoneFilterNotifier.new);
