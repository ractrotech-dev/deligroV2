import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/core/updates.dart';
import 'package:deligro_manager/data/auth_repository.dart';
import 'package:deligro_manager/data/manager_repository.dart';
import 'package:deligro_manager/models/account.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/router.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'helpers.dart';

/// Answers the update check with whatever the test last set; null is no signal.
class _UpdateRepo extends Mock implements ManagerRepository {
  AppVersionInfo? answer;
  @override
  Future<AppVersionInfo?> appVersion() async => answer;
}

const meJson = {
  'profile': {'id': 'u1', 'fullName': 'Asha Verma', 'phone': '+919876543210', 'email': 'a@x.in', 'role': 'manager'},
  'zones': {
    'all': false,
    'cities': [
      {
        'id': 'c1',
        'name': 'Bemetara',
        'zones': [
          {'id': 'z1', 'name': 'Bemetara', 'slug': 'bemetara', 'isDefault': true},
        ],
      },
    ],
  },
  'permissions': {'manager.orders.view': true, 'manager.finance.approve_payment': false},
};

void main() {
  group('ManagerMe', () {
    test('parses the /api/manager/me shape', () {
      final me = ManagerMe.fromJson(meJson);
      expect(me.profile.displayName, 'Asha Verma');
      expect(me.zones.zones.single.name, 'Bemetara');
      expect(me.zones.zones.single.cityName, 'Bemetara');
      expect(me.hasNoZones, isFalse);
      expect(me.isAdmin, isFalse);
    });

    test('can() follows the permission map and is off for unknown keys', () {
      final me = ManagerMe.fromJson(meJson);
      expect(me.can('manager.orders.view'), isTrue);
      expect(me.can('manager.finance.approve_payment'), isFalse);
      expect(me.can('manager.not_a_key'), isFalse);
    });

    test('a manager with no zones is flagged', () {
      final me = ManagerMe.fromJson({...meJson, 'zones': {'all': false, 'cities': []}});
      expect(me.hasNoZones, isTrue);
    });

    test('an admin with all zones is never flagged as having none', () {
      final me = ManagerMe.fromJson({...meJson, 'zones': {'all': true, 'cities': []}});
      expect(me.hasNoZones, isFalse);
    });
  });

  group('mobile numbers', () {
    test('accepts 10 digits, +91 and spaces', () {
      expect(AuthRepository.normaliseMobile('98765 43210'), '9876543210');
      expect(AuthRepository.normaliseMobile('+91 98765-43210'), '9876543210');
    });
    test('refuses short or non-Indian-mobile numbers', () {
      expect(AuthRepository.normaliseMobile('12345'), isNull);
      expect(AuthRepository.normaliseMobile('5876543210'), isNull);
    });
  });

  group('a required update', () {
    test('holds every location, signed in or not, deep links included', () {
      for (final path in ['/', '/login', '/orders/o-1', '/more/approvals']) {
        expect(gateRedirect(signedIn: true, me: const AsyncData(null), path: path, updateRequired: true), updateRequiredPath);
        expect(gateRedirect(signedIn: false, me: const AsyncData(null), path: path, updateRequired: true), updateRequiredPath);
      }
      expect(gateRedirect(signedIn: true, me: const AsyncData(null), path: updateRequiredPath, updateRequired: true), isNull);
    });

    test('lifted, the update screen lets go', () {
      expect(gateRedirect(signedIn: false, me: const AsyncData(null), path: updateRequiredPath), '/');
    });

    AppVersionInfo info({required bool available, required bool force}) =>
        AppVersionInfo(updateAvailable: available, forceUpdate: force, latestVersionCode: 9, apkUrl: '', notes: '');

    test('only an available, forced update blocks', () {
      expect(isBlocking(null), isFalse);
      expect(isBlocking(info(available: true, force: false)), isFalse);
      expect(isBlocking(info(available: false, force: true)), isFalse);
      expect(isBlocking(info(available: true, force: true)), isTrue);
    });

    test('a recheck adopts an answer, and no answer changes nothing', () async {
      final repo = _UpdateRepo();
      final c = ProviderContainer(overrides: [managerRepoProvider.overrideWithValue(repo)]);
      addTearDown(c.dispose);
      repo.answer = info(available: false, force: false);
      await c.read(updateProvider.future);
      expect(isBlocking(c.read(updateProvider).value), isFalse);

      // Published while the app was away: it holds on the way back.
      repo.answer = info(available: true, force: true);
      await c.read(updateProvider.notifier).recheck();
      expect(isBlocking(c.read(updateProvider).value), isTrue);

      // No signal must not lift it.
      repo.answer = null;
      await c.read(updateProvider.notifier).recheck();
      expect(isBlocking(c.read(updateProvider).value), isTrue);

      // The admin lifted it.
      repo.answer = info(available: false, force: false);
      await c.read(updateProvider.notifier).recheck();
      expect(isBlocking(c.read(updateProvider).value), isFalse);
    });

    testWidgets('the screen has no way out but updating', (tester) async {
      final repo = _UpdateRepo()..answer = AppVersionInfo(updateAvailable: true, forceUpdate: true, latestVersionCode: 9, apkUrl: 'https://example.com/a.apk', notes: '');
      await tester.pumpWidget(await themed(const UpdateRequiredScreen(), overrides: [managerRepoProvider.overrideWithValue(repo)]));
      await tester.pumpAndSettle();
      expect(find.text('Update required'), findsOneWidget);
      expect(find.byKey(const Key('update-download')), findsOneWidget);
      expect(find.text('Later'), findsNothing);
      expect(tester.widget<PopScope>(find.byType(PopScope).first).canPop, isFalse);
    });
  });

  group('gateRedirect', () {
    final me = ManagerMe.fromJson(meJson);

    test('signed out goes to login', () {
      expect(gateRedirect(signedIn: false, me: const AsyncData(null), path: '/'), '/login');
      expect(gateRedirect(signedIn: false, me: const AsyncData(null), path: '/login'), isNull);
    });

    test('signed in while /me loads waits on boot', () {
      expect(gateRedirect(signedIn: true, me: const AsyncLoading(), path: '/login'), '/boot');
    });

    test('403 forbidden goes to the not-a-manager screen', () {
      final err = AsyncError<ManagerMe?>(ApiException(403, 'forbidden'), StackTrace.empty);
      expect(gateRedirect(signedIn: true, me: err, path: '/'), '/not-manager');
      expect(gateRedirect(signedIn: true, me: err, path: '/not-manager'), isNull);
    });

    test('any other failure goes to boot with Retry', () {
      final err = AsyncError<ManagerMe?>(ApiException(0, 'network'), StackTrace.empty);
      expect(gateRedirect(signedIn: true, me: err, path: '/'), '/boot');
    });

    test('a loaded manager leaves the gate screens for home and stays elsewhere', () {
      expect(gateRedirect(signedIn: true, me: AsyncData(me), path: '/login'), '/');
      expect(gateRedirect(signedIn: true, me: AsyncData(me), path: '/boot'), '/');
      expect(gateRedirect(signedIn: true, me: AsyncData(me), path: '/more/profile'), isNull);
    });
  });
}
