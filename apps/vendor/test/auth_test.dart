import 'package:deligro_partner/core/api.dart';
import 'package:deligro_partner/core/errors.dart';
import 'package:deligro_partner/data/auth_repository.dart';
import 'package:deligro_partner/data/vendor_repository.dart';
import 'package:deligro_partner/features/auth/no_shop_screen.dart';
import 'package:deligro_partner/models/vendor_me.dart';
import 'package:deligro_partner/router.dart';
import 'package:deligro_partner/state/prefs.dart';
import 'package:deligro_partner/state/providers.dart';
import 'package:deligro_partner/state/session.dart';
import 'package:deligro_partner/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class _MockVendorRepo extends Mock implements VendorRepository {}

class _MockAuthRepo extends Mock implements AuthRepository {}

VendorMe _me({List<String> slugs = const ['spice-hub'], String active = 'spice-hub'}) => VendorMe(
      profileId: 'u1',
      fullName: 'Asha',
      phone: '+919876543210',
      role: 'restaurant',
      shops: [for (final s in slugs) Shop(id: s, slug: s, name: s, isOpen: true)],
      activeSlug: active,
      features: const {'vendor.menu_edit': true},
    );

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  group('password sign-in', () {
    test('a refused password points to OTP, in both languages', () {
      expect(friendlyError('bad_credentials'), contains('sign in with OTP'));
      expect(friendlyError('bad_credentials', hi: true), contains('OTP'));
    });

    test('a refused mobile login surfaces as bad_credentials', () async {
      final api = ApiClient(
        GoTrueClient(url: 'http://localhost:1'),
        client: MockClient((_) async => http.Response('{"error":"bad_credentials"}', 401)),
      );
      final repo = AuthRepository(GoTrueClient(url: 'http://localhost:1'), api);
      await expectLater(
        repo.passwordLogin('9876543210', 'wrong'),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'bad_credentials')),
      );
    });

    test('an invalid mobile number is refused before any request', () async {
      var called = false;
      final api = ApiClient(
        GoTrueClient(url: 'http://localhost:1'),
        client: MockClient((_) async {
          called = true;
          return http.Response('{}', 200);
        }),
      );
      final repo = AuthRepository(GoTrueClient(url: 'http://localhost:1'), api);
      await expectLater(
        repo.passwordLogin('12345', 'x'),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'invalid_phone')),
      );
      expect(called, isFalse);
    });
  });

  group('the gate', () {
    const loading = AsyncLoading<Object?>();
    test('signed out goes to login', () {
      expect(gateRedirect(signedIn: false, me: const AsyncData(null), path: '/'), '/login');
      expect(gateRedirect(signedIn: false, me: const AsyncData(null), path: '/login'), isNull);
    });
    test('signed in waits on the boot screen while the shop loads', () {
      expect(gateRedirect(signedIn: true, me: loading, path: '/login'), '/boot');
    });
    test('an account with no shop is told so', () {
      final me = AsyncError<Object?>(ApiException(403, 'forbidden'), StackTrace.empty);
      expect(gateRedirect(signedIn: true, me: me, path: '/boot'), '/no-shop');
      final none = AsyncError<Object?>(ApiException(404, 'no_restaurant'), StackTrace.empty);
      expect(gateRedirect(signedIn: true, me: none, path: '/'), '/no-shop');
    });
    test('a server fault stays on boot, with Retry', () {
      final me = AsyncError<Object?>(ApiException(0, 'network'), StackTrace.empty);
      expect(gateRedirect(signedIn: true, me: me, path: '/'), '/boot');
    });
    test('a loaded vendor goes into the app and stays there', () {
      expect(gateRedirect(signedIn: true, me: AsyncData(_me()), path: '/login'), '/');
      expect(gateRedirect(signedIn: true, me: AsyncData(_me()), path: '/orders'), isNull);
    });
  });

  group('the vendor record', () {
    late SharedPreferences prefs;
    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      prefs = await SharedPreferences.getInstance();
    });

    ProviderContainer container(VendorRepository vendor, AuthRepository auth) {
      final c = ProviderContainer(overrides: [
        prefsProvider.overrideWithValue(prefs),
        signedInProvider.overrideWithValue(true),
        vendorRepoProvider.overrideWithValue(vendor),
        authRepoProvider.overrideWithValue(auth),
      ]);
      addTearDown(c.dispose);
      return c;
    }

    test('an expired session (401) signs out', () async {
      final vendor = _MockVendorRepo();
      final auth = _MockAuthRepo();
      when(vendor.me).thenThrow(ApiException(401, 'unauthenticated'));
      when(auth.signOut).thenAnswer((_) async {});
      final c = container(vendor, auth);
      expect(await c.read(vendorMeProvider.future), isNull);
      verify(auth.signOut).called(1);
    });

    test('a saved shop the server did not pick is replaced by the server\'s', () async {
      prefs.setString(ActiveShopSlugNotifier.key, 'not-mine');
      final vendor = _MockVendorRepo();
      when(vendor.me).thenAnswer((_) async => _me(slugs: ['spice-hub', 'chai-point'], active: 'chai-point'));
      final c = container(vendor, _MockAuthRepo());
      await c.read(vendorMeProvider.future);
      await Future<void>.delayed(Duration.zero);
      expect(c.read(activeShopSlugProvider), 'chai-point');
    });
  });

  testWidgets('the no-shop screen offers sign out', (t) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    await t.pumpWidget(ProviderScope(
      overrides: [prefsProvider.overrideWithValue(prefs)],
      child: MaterialApp(theme: buildTheme(Brightness.light), home: const NoShopScreen()),
    ));
    expect(find.text('No shop on this account'), findsOneWidget);
    expect(find.text('Sign out'), findsOneWidget);
  });
}
