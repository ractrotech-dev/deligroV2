import 'package:deligro_partner/core/app_links.dart';
import 'package:deligro_partner/core/feature_gates.dart';
import 'package:deligro_partner/core/push.dart';
import 'package:deligro_partner/data/vendor_repository.dart';
import 'package:deligro_partner/features/reports/reports_screen.dart';
import 'package:deligro_partner/models/vendor_me.dart';
import 'package:deligro_partner/router.dart';
import 'package:deligro_partner/state/providers.dart';
import 'package:deligro_partner/state/session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

const _uuid = '3be2e4c7-46d6-4415-98a5-9b341acf17b9';

class _Repo extends Mock implements VendorRepository {}

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  group('stored links', () {
    test('old links reach the pages they meant', () {
      expect(currentAppPath('/more/shop'), '/more/store');
      expect(currentAppPath('/more/shop/documents'), '/more/store');
      expect(currentAppPath('/menu'), '/more/products');
      expect(currentAppPath('/menu/$_uuid'), '/more/products/$_uuid');
      expect(currentAppPath('/more/payments'), '/payments');
    });

    test('a current link is left alone', () {
      for (final p in ['/orders', '/more/store', '/more/products/$_uuid', '/payments', '/nowhere']) {
        expect(currentAppPath(p), p);
      }
    });
  });

  group('push taps', () {
    test('a payment push opens Payments', () {
      expect(vendorPathFrom(null, {'url': '/payments'}), '/payments');
      expect(vendorPathFrom('/payments', null), '/payments');
    });

    test('what Deligro did to the shop or a dish opens, old links included', () {
      expect(vendorPathFrom(null, {'url': '/more/store'}), '/more/store');
      expect(vendorPathFrom(null, {'url': '/more/shop'}), '/more/store');
      expect(vendorPathFrom(null, {'url': '/more/products/$_uuid'}), '/more/products/$_uuid');
      expect(vendorPathFrom(null, {'url': '/menu/$_uuid'}), '/more/products/$_uuid');
      expect(vendorPathFrom(null, {'url': '/menu'}), '/more/products');
    });

    test('nothing else steers the app', () {
      expect(vendorPathFrom(null, {'url': '/more/settings'}), isNull);
      expect(vendorPathFrom(null, {'url': '/more/products/new'}), isNull);
      expect(vendorPathFrom('https://evil.example/x', null), isNull);
    });
  });

  group('the router', () {
    Future<ProviderContainer> app(WidgetTester t, {VendorMe? me}) {
      final repo = MockOrdersRepo();
      when(repo.board).thenAnswer((_) async => const []);
      return pumpPartner(t, router: (ref) => ref.watch(routerProvider), overrides: ordersOverrides(repo, me: me ?? fakeMe()));
    }

    testPartner('a link with no page gets a sentence and a way home, not a red error', (t) async {
      final c = await app(t);
      await t.pumpAndSettle();
      c.read(routerProvider).go('/no/such/page');
      await t.pumpAndSettle();
      expect(find.byKey(const Key('not-found-text')), findsOneWidget);
      expect(find.textContaining('no routes'), findsNothing);
      await t.tap(find.byKey(const Key('not-found-home')));
      await t.pumpAndSettle();
      expect(c.read(routerProvider).state.matchedLocation, '/');
    });

    testPartner('an old stored link lands on the page it meant', (t) async {
      final c = await app(t);
      await t.pumpAndSettle();
      openAppLink(c.read(routerProvider), '/more/shop');
      await t.pump(const Duration(milliseconds: 300));
      expect(c.read(routerProvider).state.matchedLocation, '/more/store');
    });

    testPartner('bulk upload is closed with vendor.menu_import off', (t) async {
      final me = fakeMe(features: {...allVendorFeatures, menuImportFeature: false});
      expect(featureRedirect('/more/products/bulk', me), '/');
      expect(featureRedirect('/more/products', me), isNull);
      expect(featureRedirect('/more/products/bulk', fakeMe()), isNull);
    });
  });

  group('Reports with Earnings off', () {
    testPartner('no statistics tab, the sales report instead of an error', (t) async {
      final repo = MockOrdersRepo();
      when(repo.board).thenAnswer((_) async => const []);
      await pumpPartner(
        t,
        child: const ReportsScreen(),
        overrides: ordersOverrides(repo, me: fakeMe(features: {...allVendorFeatures, earningsFeature: false})),
      );
      await t.pump(const Duration(milliseconds: 200));
      expect(find.text('Sales analytics'), findsNothing);
      expect(find.text('Sales report'), findsOneWidget);
    });
  });

  group('rereading the switches', () {
    late _Repo repo;
    late ProviderContainer c;
    final off = fakeMe(features: {...allVendorFeatures, earningsFeature: false});

    setUp(() async {
      repo = _Repo();
      c = ProviderContainer(
        overrides: [
          signedInProvider.overrideWithValue(true),
          activeShopSlugProvider.overrideWith(_NoSlug.new),
          vendorRepoProvider.overrideWithValue(repo),
        ],
      );
      addTearDown(c.dispose);
      when(repo.me).thenAnswer((_) async => fakeMe());
      await c.read(vendorMeProvider.future);
      clearInteractions(repo);
    });

    test('a switch turned off reaches the app, with no loading state on the way', () async {
      when(repo.me).thenAnswer((_) async => off);
      final seen = <AsyncValue<VendorMe?>>[];
      c.listen(vendorMeProvider, (_, next) => seen.add(next));
      await c.read(vendorMeProvider.notifier).refresh(force: true);
      expect(c.read(vendorMeProvider).value!.can(earningsFeature), isFalse);
      expect(seen.where((v) => v.isLoading), isEmpty, reason: 'loading would send the vendor to /boot');
    });

    test('a tab change reads at most once a minute; a resume always does', () async {
      final notifier = c.read(vendorMeProvider.notifier);
      await notifier.refresh();
      verifyNever(repo.me);
      await notifier.refresh(clock: () => DateTime.now().add(refreshEvery + const Duration(seconds: 1)));
      verify(repo.me).called(1);
      await notifier.refresh(force: true);
      verify(repo.me).called(1);
    });

    test('no signal or a server fault changes nothing', () async {
      when(repo.me).thenThrow(Exception('offline'));
      await c.read(vendorMeProvider.notifier).refresh(force: true);
      expect(c.read(vendorMeProvider).value!.can(earningsFeature), isTrue);
      expect(c.read(vendorMeProvider).hasError, isFalse);
    });
  });
}

class _NoSlug extends ActiveShopSlugNotifier {
  @override
  String? build() => null;
}
