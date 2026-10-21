import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The rider side is English only: no Devanagari anywhere in the app or its
/// tests, and none of the old language-switch plumbing.
void main() {
  test('no Hindi and no language switch in lib/ or test/', () {
    final devanagari = RegExp('[ऀ-ॿ]');
    final banned = ['langProvider', 'friendlyIn', 'tr(ref'];
    final offenders = <String>[];

    for (final dir in ['lib', 'test']) {
      final root = Directory(dir);
      if (!root.existsSync()) continue;
      for (final f in root.listSync(recursive: true).whereType<File>()) {
        if (!f.path.endsWith('.dart')) continue;
        // This file names the banned identifiers on purpose.
        if (f.uri.pathSegments.last == 'no_hindi_test.dart') continue;
        final text = f.readAsStringSync();
        if (devanagari.hasMatch(text)) offenders.add('${f.path}: Devanagari');
        for (final b in banned) {
          if (text.contains(b)) offenders.add('${f.path}: $b');
        }
      }
    }
    expect(offenders, isEmpty, reason: offenders.join('\n'));
  });
}
