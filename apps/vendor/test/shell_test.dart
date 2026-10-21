import 'package:deligro_partner/features/more/more_screen.dart';
import 'package:deligro_partner/models/vendor_me.dart';
import 'package:deligro_partner/router.dart';
import 'package:deligro_partner/state/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

VendorMe _me({int shops = 1}) => fakeMe(shops: shops);

Future<ProviderContainer> _pump(
  WidgetTester t, {
  VendorMe? me,
  String? lang,
  Brightness b = Brightness.light,
  double scale = 1,
}) {
  final repo = MockOrdersRepo();
  when(repo.board).thenAnswer((_) async => const []);
  return pumpPartner(t,
      router: (ref) => ref.watch(routerProvider),
      overrides: ordersOverrides(repo, me: me ?? _me()),
      lang: lang,
      b: b,
      scale: scale);
}

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  testPartner('five tabs, in English', (t) async {
    await _pump(t);
    for (final label in ['Home', 'Orders', 'Reports', 'Payments', 'More']) {
      expect(find.descendant(of: find.byType(NavigationBar), matching: find.text(label)), findsOneWidget);
    }
  });

  testPartner('five tabs, in Hindi', (t) async {
    await _pump(t, lang: 'hi');
    for (final label in ['होम', 'ऑर्डर', 'रिपोर्ट', 'भुगतान', 'और']) {
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
    final labels = moreEntries.map((e) => e.en).toList();
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

  testPartner('settings switches the language', (t) async {
    final c = await _pump(t);
    c.read(routerProvider).go('/more/settings');
    await t.pumpAndSettle();
    await t.tap(find.text('हिन्दी'));
    await t.pumpAndSettle();
    expect(find.text('सेटिंग्स'), findsOneWidget);
    GoRouter.of(t.element(find.text('सेटिंग्स'))).go('/');
  });
}
