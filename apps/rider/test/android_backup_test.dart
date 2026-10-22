import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// Ruling P8-R13: the rider app opts out of Android backup and device transfer
// entirely. A restored session cookie or offline queue on a new phone is worse
// than the rider signing in again.
void main() {
  final manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();

  test('the manifest turns backup off', () {
    expect(manifest, contains('android:allowBackup="false"'));
    expect(manifest, contains('android:fullBackupContent="false"'));
    expect(manifest, contains('android:dataExtractionRules="@xml/data_extraction_rules"'));
    // Wins over any plugin manifest that turns backup on.
    expect(manifest, contains('xmlns:tools="http://schemas.android.com/tools"'));
    expect(manifest, contains('tools:replace="android:allowBackup,android:fullBackupContent,android:dataExtractionRules"'));
  });

  test('the data extraction rules exclude everything from cloud backup and device transfer', () {
    final rules = File('android/app/src/main/res/xml/data_extraction_rules.xml').readAsStringSync();
    for (final section in ['cloud-backup', 'device-transfer']) {
      final body = RegExp('<$section[^>]*>(.*?)</$section>', dotAll: true).firstMatch(rules)?.group(1);
      expect(body, isNotNull, reason: section);
      for (final domain in [
        'root', 'file', 'database', 'sharedpref', 'external',
        'device_root', 'device_file', 'device_database', 'device_sharedpref',
      ]) {
        expect(body, contains('<exclude domain="$domain" path="."/>'), reason: '$section $domain');
      }
    }
  });
}
