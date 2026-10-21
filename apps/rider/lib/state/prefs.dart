import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Overridden in main() with the loaded instance.
final prefsProvider = Provider<SharedPreferences>(
  (_) => throw UnimplementedError('prefsProvider must be overridden'),
);

class ThemeModeNotifier extends Notifier<ThemeMode> {
  static const _key = 'deligro-theme';

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

/// The rider's own switches. One place that knows the keys, because the phone's
/// ring service reads two of them straight from the same file
/// (`flutter.ring_sound`, `flutter.ring_vibrate` in FlutterSharedPreferences,
/// see RingService.kt). Settings (Task 8) writes them; the ring reads them.
class RiderPrefs {
  RiderPrefs(this._prefs);

  final SharedPreferences _prefs;

  static const ringSoundKey = 'ring_sound';
  static const ringVibrateKey = 'ring_vibrate';

  /// Whether a new-order ring plays its sound. On unless the rider turned it
  /// off; an offer held for this rider rings regardless (see RingOutput).
  bool get ringSound => _prefs.getBool(ringSoundKey) ?? true;

  /// Whether a new-order ring vibrates. Same rule as [ringSound].
  bool get ringVibrate => _prefs.getBool(ringVibrateKey) ?? true;

  Future<void> setRingSound(bool on) => _prefs.setBool(ringSoundKey, on);

  Future<void> setRingVibrate(bool on) => _prefs.setBool(ringVibrateKey, on);
}

final riderPrefsProvider = Provider<RiderPrefs>((ref) => RiderPrefs(ref.watch(prefsProvider)));
