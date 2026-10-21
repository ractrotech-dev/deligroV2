import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/core/i18n.dart';
import 'package:deligro_manager/state/prefs.dart';
import 'package:deligro_manager/widgets/startup_failed.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class _MockAuth extends Mock implements GoTrueClient {}

Future<Widget> _scoped(Widget child, {Map<String, Object> prefs = const {}}) async {
  SharedPreferences.setMockInitialValues(prefs);
  final p = await SharedPreferences.getInstance();
  return ProviderScope(
    overrides: [prefsProvider.overrideWithValue(p)],
    child: MaterialApp(home: child),
  );
}

class _Label extends ConsumerWidget {
  const _Label();
  @override
  Widget build(BuildContext context, WidgetRef ref) => Text(tr(ref, 'Orders', 'ऑर्डर'));
}

void main() {
  testWidgets('tr shows English by default', (tester) async {
    await tester.pumpWidget(await _scoped(const _Label()));
    expect(find.text('Orders'), findsOneWidget);
  });

  testWidgets('tr shows Hindi when the language is hi', (tester) async {
    await tester.pumpWidget(await _scoped(const _Label(), prefs: {'manager-lang': 'hi'}));
    expect(find.text('ऑर्डर'), findsOneWidget);
  });

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
