import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The rider side is English only (owner, 2026-10-21): no Devanagari
/// anywhere in the app, its tests or its tools, and none of the language-switch
/// plumbing: no language provider or setting, no translation helper, no Hindi
/// copies of names or titles.
void main() {
  /// Every text file the app is made from.
  const dirs = ['lib', 'test', 'tool'];
  const extensions = ['.dart', '.mjs', '.js', '.json', '.yaml', '.arb', '.md', '.txt'];

  final devanagari = RegExp('[\u0900-\u097F]');

  /// Identifier and word patterns of a language switch, with what they mean.
  final banned = <String, RegExp>{
    'a language provider': RegExp(r'\b(lang|language|locale|appLanguage)Provider\b'),
    'a language setting': RegExp(r'\b(languages?|hindi)\b', caseSensitive: false),
    'a translation helper': RegExp(r'\btr\(|\bfriendlyIn\b|\bbilingual\b'),
    'a Hindi field': RegExp(r'\b\w+_hi\b|\b[a-z]\w*Hi\b'),
  };

  List<File> sources() => [
    for (final dir in dirs)
      if (Directory(dir).existsSync())
        for (final f in Directory(dir).listSync(recursive: true).whereType<File>())
          if (extensions.any(f.path.endsWith) &&
              // This file names the banned patterns on purpose.
              f.uri.pathSegments.last != 'no_hindi_test.dart')
            f,
  ];

  test('lib/, test/ and tool/ are all read', () {
    final files = sources();
    for (final dir in dirs) {
      expect(
        files.any((f) => f.path.replaceAll('\\', '/').startsWith('$dir/')),
        isTrue,
        reason: 'no files read under $dir/',
      );
    }
  });

  test('no Devanagari and no language switch in lib/, test/ or tool/', () {
    final offenders = <String>[];
    for (final f in sources()) {
      final lines = f.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        final line = lines[i];
        if (devanagari.hasMatch(line)) offenders.add('${f.path}:${i + 1}: Devanagari');
        for (final MapEntry(key: what, value: pattern) in banned.entries) {
          final m = pattern.firstMatch(line);
          if (m != null) offenders.add('${f.path}:${i + 1}: $what ("${m[0]}")');
        }
      }
    }
    expect(offenders, isEmpty, reason: offenders.join('\n'));
  });

  test('the patterns catch what they are for', () {
    bool caught(String line) => devanagari.hasMatch(line) || banned.values.any((p) => p.hasMatch(line));
    for (final line in [
      'final lang = ref.watch(langProvider);',
      'ref.read(languageProvider.notifier).set(x);',
      "title: 'Language',",
      "label: 'Hindi',",
      "tr(ref, 'Go online', 'x')",
      "final name = j['name_hi'];",
      'final String? nameHi;',
      // Devanagari, written as escapes so that this file holds none itself.
      'Hello \u0928\u092E\u0938\u094D\u0924\u0947',
    ]) {
      expect(caught(line), isTrue, reason: line);
    }
    for (final line in [
      "title: 'Notifications',",
      'final highDemand = true;',
      "'shop': shop.name,",
      'child: RefreshIndicator(',
    ]) {
      expect(caught(line), isFalse, reason: line);
    }
  });
}
