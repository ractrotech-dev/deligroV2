import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Overridden in main() with the loaded instance.
final prefsProvider = Provider<SharedPreferences>(
  (_) => throw UnimplementedError('prefsProvider must be overridden'),
);

/// "Browse as guest" — like the web's `deligro-guest` cookie, it only lets a
/// signed-out customer look around. Checkout, orders and profile still need
/// a sign-in.
class GuestNotifier extends Notifier<bool> {
  static const _key = 'deligro-guest';

  @override
  bool build() => ref.read(prefsProvider).getBool(_key) ?? false;

  void set(bool on) {
    state = on;
    ref.read(prefsProvider).setBool(_key, on);
  }
}

final guestProvider = NotifierProvider<GuestNotifier, bool>(GuestNotifier.new);

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

/// Recent searches, newest first (stores/search-history-store.ts).
class SearchHistoryNotifier extends Notifier<List<String>> {
  static const _key = 'deligro-search-history';

  @override
  List<String> build() => ref.read(prefsProvider).getStringList(_key) ?? const [];

  void add(String q) {
    final t = q.trim();
    if (t.length < 2) return;
    state = [t, ...state.where((s) => s.toLowerCase() != t.toLowerCase())].take(8).toList();
    ref.read(prefsProvider).setStringList(_key, state);
  }

  void clear() {
    state = const [];
    ref.read(prefsProvider).remove(_key);
  }
}

final searchHistoryProvider =
    NotifierProvider<SearchHistoryNotifier, List<String>>(SearchHistoryNotifier.new);
