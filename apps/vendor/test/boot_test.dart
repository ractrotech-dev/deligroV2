import 'package:deligro_partner/core/api.dart';
import 'package:deligro_partner/core/i18n.dart';
import 'package:deligro_partner/state/prefs.dart';
import 'package:deligro_partner/widgets/startup_failed.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

void main() {
  group('tr', () {
    Future<String> say(Map<String, Object> prefs) async {
      SharedPreferences.setMockInitialValues(prefs);
      final p = await SharedPreferences.getInstance();
      late String out;
      final container = ProviderContainer(overrides: [prefsProvider.overrideWithValue(p)]);
      addTearDown(container.dispose);
      final tester = _Probe((ref) => out = tr(ref, 'Orders', 'ऑर्डर'));
      await tester.pumpWith(container);
      return out;
    }

    testWidgets('English by default', (t) async {
      _Probe.tester = t;
      expect(await say({}), 'Orders');
    });

    testWidgets('Hindi once chosen', (t) async {
      _Probe.tester = t;
      expect(await say({'partner-lang': 'hi'}), 'ऑर्डर');
    });

    testWidgets('choosing a language persists it', (t) async {
      SharedPreferences.setMockInitialValues({});
      final p = await SharedPreferences.getInstance();
      final container = ProviderContainer(overrides: [prefsProvider.overrideWithValue(p)]);
      addTearDown(container.dispose);
      container.read(langProvider.notifier).set('hi');
      expect(container.read(langProvider), 'hi');
      expect(p.getString('partner-lang'), 'hi');
    });
  });

  test('API calls carry the active shop as the vendor_restaurant_slug cookie', () async {
    String? cookie;
    String? client;
    final mock = MockClient((req) async {
      cookie = req.headers['cookie'];
      client = req.headers['x-client'];
      return http.Response('{"ok":true}', 200);
    });
    final api = ApiClient(
      GoTrueClient(url: 'http://localhost:1'),
      client: mock,
      shopSlug: () => 'spice-hub',
    );
    await api.get('/api/vendor/me');
    expect(cookie, contains('vendor_restaurant_slug=spice-hub'));
    expect(client, startsWith('deligro-partner-flutter/'));
  });

  testWidgets('a failed start says so and offers Retry', (t) async {
    var retried = false;
    await t.pumpWidget(StartupFailed(error: 'network down', onRetry: () => retried = true));
    expect(find.text("Deligro Partner couldn't start"), findsOneWidget);
    await t.tap(find.text('Retry'));
    expect(retried, isTrue);
  });
}

/// Runs [read] inside a widget so `tr` gets a real WidgetRef.
class _Probe {
  _Probe(this.read);
  static late WidgetTester tester;
  final void Function(WidgetRef ref) read;

  Future<void> pumpWith(ProviderContainer container) => tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: Consumer(builder: (_, ref, _) {
            read(ref);
            return const SizedBox();
          }),
        ),
      );
}
