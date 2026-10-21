// Screenshots of the Partner app's screens with sample data, for reviewing the
// look without a signed-in vendor. Not part of `flutter test` (it lives
// outside test/) and not a regression gate: the images depend on this PC's
// fonts. Writes PNGs to test_screens/out/ (gitignored):
//
//   flutter test test_screens --update-goldens
//
// Text uses Segoe UI / Consolas from C:\Windows\Fonts in place of Inter /
// JetBrains Mono, so the layout is real.
import 'dart:io';

import 'package:deligro_partner/features/orders/order_actions.dart';
import 'package:deligro_partner/features/orders/order_detail_screen.dart';
import 'package:deligro_partner/models/order.dart';
import 'package:deligro_partner/router.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import '../test/analytics_test.dart' show analyticsJson;
import '../test/dashboard_test.dart' show FixedDashboard, dashboardJson;
import 'package:deligro_partner/features/reports/analytics_view.dart';
import 'package:deligro_partner/models/analytics.dart';
import '../test/support/fakes.dart';
import 'package:deligro_partner/models/dashboard.dart';
import 'package:deligro_partner/state/dashboard.dart';
import 'package:deligro_partner/models/menu.dart';
import 'package:deligro_partner/models/store.dart';
import 'package:deligro_partner/state/menu.dart';
import 'package:deligro_partner/state/store.dart';
import '../test/products_test.dart' show MockMenuRepo, menuJson;
import '../test/store_test.dart' show MockStoreRepo, storeState, storeJson;

Future<void> _loadFont(String family, List<String> files) async {
  final loader = FontLoader(family);
  for (final f in files) {
    final bytes = File(f.contains('/') ? f : 'C:/Windows/Fonts/$f').readAsBytesSync();
    loader.addFont(Future.value(ByteData.view(bytes.buffer)));
  }
  await loader.load();
}

Future<void> _fonts() async {
  // google_fonts names one family per weight; register each.
  for (final w in FontWeight.values) {
    final bold = w.value >= 600;
    await _loadFont(GoogleFonts.inter(fontWeight: w).fontFamily!, [bold ? 'segoeuib.ttf' : 'segoeui.ttf']);
    await _loadFont(GoogleFonts.jetBrainsMono(fontWeight: w).fontFamily!, [bold ? 'consolab.ttf' : 'consola.ttf']);
  }
  await _loadFont('Roboto', ['segoeui.ttf', 'segoeuib.ttf']);
  await _loadFont('MaterialIcons', ['F:/dev/flutter/bin/cache/artifacts/material_fonts/materialicons-regular.otf']);
}

void main() {
  setUpAll(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await _fonts();
  });

  late MockOrdersRepo repo;
  setUp(() {
    repo = MockOrdersRepo();
    when(repo.board).thenAnswer((_) async => fakeBoard());
    when(() => repo.history(
          kind: any(named: 'kind'),
          range: any(named: 'range'),
          date: any(named: 'date'),
          search: any(named: 'search'),
          limit: any(named: 'limit'),
        )).thenAnswer((_) async => (
          orders: [
            fakeOrder('ff66ff66-0000-0000-0000-000000000006', status: 'delivered', name: 'Kiran Patel', minutesAgo: 300),
            fakeOrder('ab12ab12-0000-0000-0000-000000000007', status: 'delivered', name: 'Sunil Rao', minutesAgo: 1500),
          ],
          total: 2
        ));
  });

  Future<void> shot(WidgetTester t, String name, {Brightness b = Brightness.light}) async {
    await t.pumpAndSettle();
    await expectLater(find.byType(MaterialApp).first, matchesGoldenFile('out/$name${b == Brightness.dark ? '-dark' : ''}.png'));
  }

  for (final b in [Brightness.light, Brightness.dark]) {
    testPartner('orders live ($b)', (t) async {
      final c = await pumpPartner(t, router: (ref) => ref.watch(routerProvider), overrides: ordersOverrides(repo), b: b);
      c.read(routerProvider).go('/orders');
      await shot(t, 'orders-live', b: b);
      await t.tap(find.text('Past'));
      await shot(t, 'orders-past', b: b);
    });

    testPartner('order detail ($b)', (t) async {
      const id = 'aa11aa11-0000-0000-0000-000000000001';
      when(() => repo.detail(id)).thenAnswer((_) async => VendorOrder.fromJson(fakeOrderJson(id, events: [
            {'kind': 'status', 'to': 'placed', 'by': 'customer', 'at': DateTime.now().subtract(const Duration(minutes: 2)).toIso8601String()},
          ])));
      await pumpPartner(t, child: const OrderDetailScreen(orderId: id), overrides: ordersOverrides(repo), b: b);
      await shot(t, 'order-new', b: b);
      await t.tap(find.text('Accept'));
      await shot(t, 'accept-sheet', b: b);
    });
  }

  testPartner('order detail ready', (t) async {
    const id = 'dd44dd44-0000-0000-0000-000000000004';
    when(() => repo.detail(id)).thenAnswer((_) async => VendorOrder.fromJson(fakeOrderJson(id, status: 'ready', pickupOtp: '4821', rider: 'Ravi Sahu', events: [
          {'kind': 'status', 'to': 'placed', 'by': 'customer', 'at': DateTime.now().subtract(const Duration(minutes: 25)).toIso8601String()},
          {'kind': 'status', 'from': 'placed', 'to': 'kitchen', 'by': 'you', 'at': DateTime.now().subtract(const Duration(minutes: 24)).toIso8601String()},
          {'kind': 'preparing', 'from': 'kitchen', 'to': 'kitchen', 'by': 'you', 'at': DateTime.now().subtract(const Duration(minutes: 22)).toIso8601String()},
          {'kind': 'status', 'from': 'kitchen', 'to': 'ready', 'by': 'you', 'at': DateTime.now().subtract(const Duration(minutes: 3)).toIso8601String()},
        ])));
    await pumpPartner(t, child: const OrderDetailScreen(orderId: id), overrides: ordersOverrides(repo));
    await shot(t, 'order-ready');
    await t.drag(find.byType(ListView), const Offset(0, -1200));
    await shot(t, 'order-ready-bottom');
  });

  testPartner('reject sheet', (t) async {
    await pumpPartner(t, child: Builder(builder: (context) {
      WidgetsBinding.instance.addPostFrameCallback((_) => showRejectSheet(context));
      return const Scaffold();
    }), overrides: ordersOverrides(repo));
    await shot(t, 'reject-sheet');
  });

  for (final b in [Brightness.light, Brightness.dark]) {
    testPartner('dashboard ($b)', (t) async {
      await pumpPartner(t, router: (ref) => ref.watch(routerProvider), overrides: [
        ...ordersOverrides(repo),
        dashboardProvider.overrideWith(() => FixedDashboard(Dashboard.fromJson(dashboardJson()))),
      ], b: b);
      await shot(t, 'dashboard', b: b);
      await t.drag(find.byType(ListView).first, const Offset(0, -700));
      await shot(t, 'dashboard-bottom', b: b);
    });
  }

  for (final b in [Brightness.light, Brightness.dark]) {
    testPartner('analytics ($b)', (t) async {
      final c = await pumpPartner(t, router: (ref) => ref.watch(routerProvider), overrides: [
        ...ordersOverrides(repo),
        analyticsProvider.overrideWith((ref, q) async => Analytics.fromJson(analyticsJson())),
      ], b: b);
      c.read(routerProvider).go('/reports');
      await shot(t, 'analytics', b: b);
      await t.drag(find.byType(ListView).first, const Offset(0, -800));
      await shot(t, 'analytics-bottom', b: b);
    });
  }

  testPartner('more and settings', (t) async {
    final c = await pumpPartner(t, router: (ref) => ref.watch(routerProvider), overrides: ordersOverrides(repo));
    c.read(routerProvider).go('/more');
    await shot(t, 'more');
    c.read(routerProvider).go('/more/settings');
    await shot(t, 'settings');
  });

  for (final b in [Brightness.light, Brightness.dark]) {
    testPartner('store ($b)', (t) async {
      final store = MockStoreRepo();
      when(store.load).thenAnswer((_) async => StoreState.fromJson(storeState(store: storeJson(busy: 20))));
      final c = await pumpPartner(t, router: (ref) => ref.watch(routerProvider), overrides: [
        ...ordersOverrides(repo),
        storeRepoProvider.overrideWithValue(store),
      ], b: b);
      c.read(routerProvider).push('/more/store');
      await shot(t, 'store', b: b);
      await t.drag(find.byType(ListView).first, const Offset(0, -900));
      await shot(t, 'store-bottom', b: b);
      if (b == Brightness.light) {
        c.read(routerProvider).push('/more/store/edit');
        await shot(t, 'store-edit');
      }
    });
  }

  for (final b in [Brightness.light, Brightness.dark]) {
    testPartner('products ($b)', (t) async {
      final menu = MockMenuRepo();
      when(menu.load).thenAnswer((_) async => Menu.fromJson(menuJson()));
      final c = await pumpPartner(t, router: (ref) => ref.watch(routerProvider), overrides: [
        ...ordersOverrides(repo),
        menuRepoProvider.overrideWithValue(menu),
      ], b: b);
      c.read(routerProvider).push('/more/products');
      await shot(t, 'products', b: b);
      c.read(routerProvider).push('/more/products/11111111-0000-0000-0000-000000000002');
      await shot(t, 'product-edit', b: b);
      await t.drag(find.byType(ListView).first, const Offset(0, -1400));
      await shot(t, 'product-edit-bottom', b: b);
    });
  }
}
