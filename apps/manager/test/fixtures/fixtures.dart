import 'dart:convert';
import 'dart:io';

/// A contract fixture from `test/fixtures/api/` (written by hand from the
/// Phase 3 plan's pinned JSON; `generated/` holds the server's own output once
/// the integration task emits it).
Map<String, dynamic> apiFixture(String name) =>
    jsonDecode(File('test/fixtures/api/$name.json').readAsStringSync()) as Map<String, dynamic>;
