import 'package:deligro_rider/config/env.dart';
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/i18n.dart';
import 'package:deligro_rider/main.dart' show StartupFailed;
import 'package:deligro_rider/state/prefs.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class _Probe extends ConsumerWidget {
  const _Probe();

  @override
  Widget build(BuildContext context, WidgetRef ref) =>
      Text(tr(ref, 'Sign in', 'साइन इन'), textDirection: TextDirection.ltr);
}

Future<SharedPreferences> _prefs([Map<String, Object> values = const {}]) async {
  SharedPreferences.setMockInitialValues(values);
  return SharedPreferences.getInstance();
}

void main() {
  group('tr / langProvider', () {
    testWidgets('English by default', (tester) async {
      final prefs = await _prefs();
      await tester.pumpWidget(ProviderScope(
        overrides: [prefsProvider.overrideWithValue(prefs)],
        child: const _Probe(),
      ));
      expect(find.text('Sign in'), findsOneWidget);
    });

    testWidgets('Hindi when the language is hi', (tester) async {
      final prefs = await _prefs({'lang': 'hi'});
      await tester.pumpWidget(ProviderScope(
        overrides: [prefsProvider.overrideWithValue(prefs)],
        child: const _Probe(),
      ));
      expect(find.text('साइन इन'), findsOneWidget);
    });

    test('the choice is persisted under "lang" and survives a new container', () async {
      final prefs = await _prefs();
      final a = ProviderContainer(overrides: [prefsProvider.overrideWithValue(prefs)]);
      addTearDown(a.dispose);
      expect(a.read(langProvider), 'en');

      a.read(langProvider.notifier).set('hi');
      expect(a.read(langProvider), 'hi');
      expect(prefs.getString('lang'), 'hi');

      final b = ProviderContainer(overrides: [prefsProvider.overrideWithValue(prefs)]);
      addTearDown(b.dispose);
      expect(b.read(langProvider), 'hi');
    });

    test('an unknown stored value falls back to English', () async {
      final prefs = await _prefs({'lang': 'fr'});
      final c = ProviderContainer(overrides: [prefsProvider.overrideWithValue(prefs)]);
      addTearDown(c.dispose);
      expect(c.read(langProvider), 'en');
    });
  });

  test('ApiClient identifies itself as the rider app', () async {
    expect(Env.versionCode, 3);
    final seen = <http.Request>[];
    final client = MockClient((req) async {
      seen.add(req);
      return http.Response('{"ok":true}', 200);
    });
    final supabase = SupabaseClient(
      'http://localhost:1',
      'test-key',
      authOptions: const AuthClientOptions(autoRefreshToken: false),
    );
    addTearDown(supabase.dispose);

    final body = await ApiClient(supabase.auth, client: client).get('/api/rider/me');

    expect(body['ok'], true);
    expect(seen.single.headers['x-client'], 'deligro-rider-flutter/3');
  });

  testWidgets('startup failure says Deligro Rider could not start and offers Retry',
      (tester) async {
    await tester.pumpWidget(StartupFailed(error: Exception('boom')));

    expect(find.text("Deligro Rider couldn't start"), findsOneWidget);
    expect(find.text('Retry'), findsOneWidget);
    expect(find.textContaining('boom'), findsOneWidget);
  });
}
