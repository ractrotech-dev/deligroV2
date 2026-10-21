import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/prefs.dart';

/// The app's language: `'en'` (default) or `'hi'`. Every label is written as
/// an English/Hindi pair at the point of use — `tr(ref, 'Orders', 'ऑर्डर')` —
/// so a screen reads in one language and nothing is missing a translation.
class LangNotifier extends Notifier<String> {
  static const _key = 'partner-lang';

  @override
  String build() => ref.read(prefsProvider).getString(_key) == 'hi' ? 'hi' : 'en';

  void set(String lang) {
    state = lang == 'hi' ? 'hi' : 'en';
    ref.read(prefsProvider).setString(_key, state);
  }
}

final langProvider = NotifierProvider<LangNotifier, String>(LangNotifier.new);

/// The label in the chosen language. Watches, so call it from `build`; in a
/// callback use [trNow].
String tr(WidgetRef ref, String en, String hi) =>
    ref.watch(langProvider) == 'hi' ? hi : en;

/// [tr] for callbacks and async code, where watching is not allowed.
String trNow(WidgetRef ref, String en, String hi) =>
    ref.read(langProvider) == 'hi' ? hi : en;

bool isHindi(WidgetRef ref) => ref.read(langProvider) == 'hi';
