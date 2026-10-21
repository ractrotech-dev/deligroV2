import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/data/auth_repository.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/router.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

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
