import 'package:deligro_partner/core/api.dart';
import 'package:deligro_partner/widgets/startup_failed.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

void main() {
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
