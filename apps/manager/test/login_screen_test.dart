import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/data/auth_repository.dart';
import 'package:deligro_manager/features/auth/gate_screens.dart';
import 'package:deligro_manager/features/auth/login_screen.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'helpers.dart';

class _MockAuthRepo extends Mock implements AuthRepository {}

Future<_MockAuthRepo> _pump(WidgetTester tester) async {
  final repo = _MockAuthRepo();
  await tester.pumpWidget(await themed(const LoginScreen(), overrides: [authRepoProvider.overrideWithValue(repo)]));
  return repo;
}

void main() {
  testWidgets('offers mobile & password, OTP and email', (tester) async {
    await _pump(tester);
    expect(find.text('Mobile & password'), findsOneWidget);
    expect(find.text('OTP'), findsOneWidget);
    expect(find.text('Email'), findsOneWidget);
  });

  testWidgets('an invalid mobile is refused before anything is sent', (tester) async {
    final repo = await _pump(tester);
    await tester.enterText(find.byKey(const Key('login-mobile')), '12345');
    await tester.enterText(find.byKey(const Key('login-password')), 'secret123');
    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pump();
    expect(find.text('Enter a valid 10-digit Indian mobile number.'), findsOneWidget);
    verifyNever(() => repo.passwordLogin(any(), any()));
  });

  testWidgets('a valid mobile and password are sent', (tester) async {
    final repo = await _pump(tester);
    when(() => repo.passwordLogin(any(), any())).thenAnswer((_) async {});
    await tester.enterText(find.byKey(const Key('login-mobile')), '98765 43210');
    await tester.enterText(find.byKey(const Key('login-password')), 'secret123');
    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pump();
    verify(() => repo.passwordLogin('98765 43210', 'secret123')).called(1);
  });

  testWidgets('wrong credentials say so plainly', (tester) async {
    final repo = await _pump(tester);
    when(() => repo.passwordLogin(any(), any())).thenThrow(ApiException(401, 'bad_credentials'));
    await tester.enterText(find.byKey(const Key('login-mobile')), '9876543210');
    await tester.enterText(find.byKey(const Key('login-password')), 'nope-nope');
    await tester.tap(find.byKey(const Key('login-submit')));
    await tester.pump();
    expect(find.text('Wrong mobile number, email or password.'), findsOneWidget);
  });

  testWidgets('OTP asks for the number first, then the code', (tester) async {
    final repo = await _pump(tester);
    when(() => repo.requestOtp(any())).thenAnswer((_) async => (devMode: false, devCode: null));
    await tester.tap(find.text('OTP'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('otp-mobile')), '9876543210');
    await tester.tap(find.byKey(const Key('otp-send')));
    await tester.pumpAndSettle();
    verify(() => repo.requestOtp('9876543210')).called(1);
    expect(find.byKey(const Key('otp-code')), findsOneWidget);
  });

  testWidgets('a non-manager is told so and can sign out', (tester) async {
    final repo = _MockAuthRepo();
    when(() => repo.signOut()).thenAnswer((_) async {});
    await tester.pumpWidget(await themed(const NotManagerScreen(), overrides: [authRepoProvider.overrideWithValue(repo)]));
    expect(find.text("This account isn't a manager"), findsOneWidget);
    await tester.tap(find.byKey(const Key('not-manager-sign-out')));
    verify(() => repo.signOut()).called(1);
  });
}
