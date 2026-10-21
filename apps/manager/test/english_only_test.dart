import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The Manager app is English only (owner, 2026-10-21): no Hindi string, field
/// or language switch anywhere in its code.
void main() {
  test('no Devanagari anywhere under lib/', () {
    final devanagari = RegExp(r'[\u0900-\u097F]');
    final offenders = <String>[];
    for (final f in Directory('lib').listSync(recursive: true).whereType<File>()) {
      if (!f.path.endsWith('.dart')) continue;
      final lines = f.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        if (devanagari.hasMatch(lines[i])) offenders.add('${f.path}:${i + 1}');
      }
    }
    expect(offenders, isEmpty);
  });

  test('there is no language switch or translation helper', () {
    expect(File('lib/core/i18n.dart').existsSync(), isFalse);
    final settings = File('lib/features/settings/settings_screen.dart').readAsStringSync();
    expect(settings.contains("GroupLabel('Language')"), isFalse);
  });
}
