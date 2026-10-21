import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/prefs.dart';

/// The app language: `'en'` or `'hi'`. Persisted in prefs under `lang`, so it
/// survives a restart; anything else stored there reads as English.
class LangNotifier extends Notifier<String> {
  static const _key = 'lang';

  @override
  String build() => ref.read(prefsProvider).getString(_key) == 'hi' ? 'hi' : 'en';

  void set(String lang) {
    final next = lang == 'hi' ? 'hi' : 'en';
    state = next;
    ref.read(prefsProvider).setString(_key, next);
  }
}

final langProvider = NotifierProvider<LangNotifier, String>(LangNotifier.new);

/// Picks the Hindi or English copy for the current language. Watches the
/// language, so the calling widget rebuilds when it changes.
String tr(WidgetRef ref, String en, String hi) =>
    ref.watch(langProvider) == 'hi' ? hi : en;
