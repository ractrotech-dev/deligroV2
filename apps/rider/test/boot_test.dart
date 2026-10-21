import 'package:deligro_rider/config/env.dart';
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/main.dart' show StartupFailed;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

void main() {
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
