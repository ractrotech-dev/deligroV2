import 'package:deligro_partner/core/feature_gates.dart';
import 'package:deligro_partner/features/more/more_screen.dart';
import 'package:deligro_partner/models/vendor_me.dart';
import 'package:deligro_partner/router.dart';
import 'package:deligro_partner/state/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

VendorMe _me({int shops = 1}) => fakeMe(shops: shops);

Future<ProviderContainer> _pump(WidgetTester t, {VendorMe? me, Brightness b = Brightness.light, double scale = 1}) {
  final repo = MockOrdersRepo();
  when(repo.board).thenAnswer((_) async => const []);
  return pumpPartner(
    t,
    router: (ref) => ref.watch(routerProvider),
    overrides: ordersOverrides(repo, me: me ?? _me()),
    b: b,
    scale: scale,
  );
}

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  testPartner('a new order pops up on Home with Accept and Reject', (t) async {
    final repo = MockOrdersRepo();
    when(repo.board).thenAnswer((_) async => fakeBoard());
    await pumpPartner(
      t,
      router: (ref) => ref.watch(routerProvider),
      overrides: ordersOverrides(repo, me: _me()),
      incomingPopup: true,
    );
    for (var i = 0; i < 4; i++) {
      await t.pump(const Duration(milliseconds: 300));
    }
    expect(find.text('NEW ORDER'), findsOneWidget);
    expect(find.text('Order #D-AA11'), findsOneWidget);
    expect(find.text('Accept'), findsOneWidget);
    expect(find.text('Reject'), findsOneWidget);
    // "Later" puts it away; it does not come straight back.
    await t.tap(find.text('Later'));
    for (var i = 0; i < 4; i++) {
      await t.pump(const Duration(milliseconds: 300));
    }
    expect(find.text('NEW ORDER'), findsNothing);
  });

  testPartner('five tabs, in English', (t) async {
    await _pump(t);
    for (final label in ['Home', 'Orders', 'Reports', 'Payments', 'More']) {
      expect(find.descendant(of: find.byType(NavigationBar), matching: find.text(label)), findsOneWidget);
    }
  });

  testPartner('an owner of two shops can switch between them', (t) async {
    final c = await _pump(t, me: _me(shops: 2));
    await t.tap(find.text('Spice Hub Restaurant'));
    await t.pumpAndSettle();
    expect(find.text('Chai Point'), findsOneWidget);
    await t.tap(find.text('Chai Point'));
    await t.pumpAndSettle();
    expect(c.read(activeShopSlugProvider), 'chai-point');
  });

  testPartner('More lists its nine entries in order', (t) async {
    await _pump(t);
    await t.tap(find.text('More'));
    await t.pumpAndSettle();
    final labels = moreEntries.map((e) => e.label).toList();
    expect(labels, [
      'Store',
      'Products & inventory',
      'Offers',
      'Marketing requests',
      'Customer reviews',
      'Invoices & receipts',
      'Help & support',
      'Notifications',
      'Settings',
    ]);
    for (final l in labels) {
      await t.scrollUntilVisible(find.text(l), 100);
      expect(find.text(l), findsOneWidget);
    }
  });

  for (final (b, scale, name) in [
    (Brightness.light, 1.0, 'light'),
    (Brightness.dark, 1.0, 'dark'),
    (Brightness.light, 1.3, 'large text'),
  ]) {
    testPartner('every tab and Settings render ($name)', (t) async {
      final c = await _pump(t, b: b, scale: scale);
      final router = c.read(routerProvider);
      for (final path in ['/', '/orders', '/reports', '/payments', '/more', '/more/settings', '/more/store']) {
        router.go(path);
        await t.pumpAndSettle();
        expect(t.takeException(), isNull, reason: path);
        expect(router.state.matchedLocation, path);
      }
    });
  }

  group('shop switches (Admin → Feature access)', () {
    Map<String, bool> without(List<String> off) => {
      for (final e in allVendorFeatures.entries) e.key: !off.contains(e.key),
    };

    testPartner('Reports and Payments leave the bar when switched off', (t) async {
      await _pump(t, me: fakeMe(features: without(['vendor.reports', 'vendor.earnings'])));
      final bar = find.byType(NavigationBar);
      for (final label in ['Home', 'Orders', 'More']) {
        expect(find.descendant(of: bar, matching: find.text(label)), findsOneWidget);
      }
      for (final label in ['Reports', 'Payments']) {
        expect(find.descendant(of: bar, matching: find.text(label)), findsNothing);
      }
      // The tab after the gap still opens its own branch.
      await t.tap(find.descendant(of: bar, matching: find.text('More')));
      await t.pumpAndSettle();
      expect(find.text('Store'), findsOneWidget);
    });

    testPartner('More drops the rows whose switch is off', (t) async {
      await _pump(
        t,
        me: fakeMe(features: without(['vendor.promotions', 'vendor.marketing', 'vendor.reviews', 'vendor.support'])),
      );
      await t.tap(find.text('More'));
      await t.pumpAndSettle();
      for (final l in ['Offers', 'Marketing requests', 'Customer reviews', 'Help & support']) {
        expect(find.text(l), findsNothing, reason: l);
      }
      expect(find.text('Store'), findsOneWidget);
    });

    testPartner('a deep link into a switched-off section goes Home', (t) async {
      final c = await _pump(t, me: fakeMe(features: without(['vendor.reviews', 'vendor.reports'])));
      final router = c.read(routerProvider);
      for (final path in ['/more/reviews', '/reports']) {
        router.go(path);
        await t.pumpAndSettle();
        expect(router.state.matchedLocation, '/', reason: path);
      }
      router.go('/more/support');
      await t.pumpAndSettle();
      expect(router.state.matchedLocation, '/more/support');
    });

    test('featureForPath maps each gated section, and nothing else', () {
      expect(featureForPath('/payments/abc'), 'vendor.earnings');
      expect(featureForPath('/reports'), 'vendor.reports');
      expect(featureForPath('/more/offers/new'), 'vendor.promotions');
      expect(featureForPath('/more/marketing'), 'vendor.marketing');
      expect(featureForPath('/more/reviews'), 'vendor.reviews');
      expect(featureForPath('/more/support/x'), 'vendor.support');
      expect(featureForPath('/orders'), isNull);
      expect(featureForPath('/orders/1'), isNull);
      expect(featureForPath('/more/reviewsx'), isNull);
    });
  });
}
