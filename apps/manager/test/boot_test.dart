import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/widgets/startup_failed.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class _MockAuth extends Mock implements GoTrueClient {}

void main() {
  test('ApiClient identifies itself as the Manager app', () async {
    final auth = _MockAuth();
    when(() => auth.currentSession).thenReturn(null);
    Map<String, String>? sent;
    final client = MockClient((req) async {
      sent = req.headers;
      return http.Response('{"ok":true}', 200, headers: {'content-type': 'application/json'});
    });
    await ApiClient(auth, client: client).get('/api/manager/me');
    expect(sent?['x-client'], 'deligro-manager-flutter/2');
  });

  test('ApiClient turns an error body into an ApiException with its code', () async {
    final auth = _MockAuth();
    when(() => auth.currentSession).thenReturn(null);
    final client = MockClient((_) async => http.Response('{"error":"forbidden"}', 403));
    expect(
      () => ApiClient(auth, client: client).get('/api/manager/me'),
      throwsA(isA<ApiException>().having((e) => e.code, 'code', 'forbidden').having((e) => e.status, 'status', 403)),
    );
  });

  testWidgets('startup failure says so and offers Retry', (tester) async {
    var retried = false;
    await tester.pumpWidget(StartupFailed(error: 'boom', onRetry: () => retried = true));
    expect(find.text('Deligro Manager couldn\'t start'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    expect(retried, isTrue);
  });
}
