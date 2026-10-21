import 'package:deligro_manager/data/auth_repository.dart';
import 'package:deligro_manager/data/manager_repository.dart';
import 'package:deligro_manager/features/profile/account_screens.dart';
import 'package:deligro_manager/models/account.dart';
import 'package:deligro_manager/state/account.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'helpers.dart';

class _MockRepo extends Mock implements ManagerRepository {}

class _MockAuth extends Mock implements AuthRepository {}

const _current = SessionInfo(
  id: 's1',
  createdAt: null,
  lastSeenAt: null,
  userAgent: 'Dart/3.13 (dart:io) deligro-manager-flutter/2',
  ip: '10.0.0.1',
  current: true,
);
const _other = SessionInfo(
  id: 's2',
  createdAt: null,
  lastSeenAt: null,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36',
  ip: '10.0.0.2',
  current: false,
);

void main() {
  testWidgets('sessions marks this device and signs out only the other one', (tester) async {
    final repo = _MockRepo();
    when(() => repo.revokeSession(any())).thenAnswer((_) async {});
    await tester.pumpWidget(await themed(const SessionsScreen(), overrides: [
      managerRepoProvider.overrideWithValue(repo),
      sessionsProvider.overrideWith((_) async => [_current, _other]),
    ]));
    await tester.pumpAndSettle();
    expect(find.text('This device'), findsOneWidget);
    expect(find.text('Chrome on Windows'), findsOneWidget);
    expect(find.byKey(const Key('revoke-s1')), findsNothing);
    await tester.tap(find.byKey(const Key('revoke-s2')));
    await tester.pumpAndSettle();
    verify(() => repo.revokeSession('s2')).called(1);
  });

  testWidgets('sign out everywhere ends the server sessions, then this one', (tester) async {
    final repo = _MockRepo();
    final auth = _MockAuth();
    when(() => repo.signOutEverywhere()).thenAnswer((_) async {});
    when(() => auth.signOut()).thenAnswer((_) async {});
    await tester.pumpWidget(await themed(const SessionsScreen(), overrides: [
      managerRepoProvider.overrideWithValue(repo),
      authRepoProvider.overrideWithValue(auth),
      sessionsProvider.overrideWith((_) async => [_current]),
    ]));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('sign-out-everywhere')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('confirm-everywhere')));
    await tester.pumpAndSettle();
    verify(() => repo.signOutEverywhere()).called(1);
    verify(() => auth.signOut()).called(1);
  });

  testWidgets('permissions lists every power, on and off, with what off means', (tester) async {
    const perms = [
      PermissionInfo(key: 'manager.orders.view', label: 'Orders', labelHi: 'ऑर्डर', offMeans: 'Hidden.', on: true, defaultOn: true),
      PermissionInfo(
        key: 'manager.finance.approve_payment',
        label: 'Approve payments',
        labelHi: 'भुगतान मंज़ूर करना',
        offMeans: 'Cannot mark a settlement or payout as paid.',
        on: false,
        defaultOn: false,
      ),
    ];
    await tester.pumpWidget(await themed(const PermissionsScreen(), overrides: [
      permissionsProvider.overrideWith((_) async => perms),
    ]));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('perm-manager.orders.view')), findsOneWidget);
    expect(find.byKey(const Key('perm-manager.finance.approve_payment')), findsOneWidget);
    expect(find.text('Cannot mark a settlement or payout as paid.'), findsOneWidget);
    expect(find.text('ON (1)'), findsOneWidget);
    expect(find.text('OFF (1)'), findsOneWidget);
  });

  testWidgets('change password refuses a mismatch before calling the server', (tester) async {
    final repo = _MockRepo();
    await tester.pumpWidget(await themed(const PasswordScreen(), overrides: [managerRepoProvider.overrideWithValue(repo)]));
    await tester.enterText(find.byKey(const Key('pw-current')), 'old-password');
    await tester.enterText(find.byKey(const Key('pw-next')), 'new-password-1');
    await tester.enterText(find.byKey(const Key('pw-confirm')), 'new-password-2');
    await tester.tap(find.byKey(const Key('pw-submit')));
    await tester.pump();
    expect(find.text('The new passwords don\'t match.'), findsOneWidget);
    verifyNever(() => repo.changePassword(any(), any()));
  });

  testWidgets('if other devices could not be signed out, the screen says so instead of closing', (tester) async {
    final repo = _MockRepo();
    when(() => repo.changePassword(any(), any())).thenAnswer((_) async => true);
    await tester.pumpWidget(await themed(const PasswordScreen(), overrides: [managerRepoProvider.overrideWithValue(repo)]));
    await tester.enterText(find.byKey(const Key('pw-current')), 'old-password');
    await tester.enterText(find.byKey(const Key('pw-next')), 'new-password-1');
    await tester.enterText(find.byKey(const Key('pw-confirm')), 'new-password-1');
    await tester.tap(find.byKey(const Key('pw-submit')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('pw-warning')), findsOneWidget);
    expect(find.textContaining('other devices may still be signed in'), findsOneWidget);
    expect(find.byType(PasswordScreen), findsOneWidget);
  });

  test('a session from a browser names the browser and system', () {
    expect(_other.device, 'Chrome on Windows');
    expect(_current.device, 'Deligro Manager app');
  });
}
