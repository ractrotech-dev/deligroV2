import 'package:deligro_manager/features/orders/order_mini_map.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/state/prefs.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/theme/app_theme.dart';
import 'package:deligro_manager/widgets/zone_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'auth_test.dart' show meJson;
import 'fakes/fake_vendor_product_repositories.dart';
import 'helpers.dart';

/// A manager in one zone with exactly [permissions] on.
class MeWith extends ManagerMeNotifier {
  MeWith(this.permissions, [this.role = 'manager']);
  final Set<String> permissions;
  final String role;

  @override
  Future<ManagerMe?> build() async => ManagerMe.fromJson({
        ...meJson,
        'profile': {...(meJson['profile'] as Map), 'role': role},
        'permissions': {for (final p in permissions) p: true},
      });
}

const vendorViewer = {'manager.vendors.view', 'manager.support.manage', 'manager.orders.view', 'manager.reports.view'};
const productViewer = {'manager.products.view', 'manager.vendors.view'};

List vpOverrides({
  FakeVendorsRepository? vendors,
  FakeProductsRepository? products,
  FakeTicketsRepository? tickets,
  Set<String> permissions = vendorViewer,
  String role = 'manager',
}) =>
    [
      vendorsRepoProvider.overrideWithValue(vendors ?? FakeVendorsRepository()),
      productsRepoProvider.overrideWithValue(products ?? FakeProductsRepository()),
      ticketsRepoProvider.overrideWithValue(tickets ?? FakeTicketsRepository()),
      managerMeProvider.overrideWith(() => MeWith(permissions, role)),
      activeZoneProvider.overrideWithValue(null),
      signedInProvider.overrideWithValue(true),
      mapTilesEnabledProvider.overrideWithValue(false),
    ];

void _size(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
}

/// Pumps [child] with fake vendor/product/ticket repositories.
Future<void> pumpVp(
  WidgetTester tester,
  Widget child, {
  FakeVendorsRepository? vendors,
  FakeProductsRepository? products,
  FakeTicketsRepository? tickets,
  Set<String> permissions = vendorViewer,
  Size size = const Size(390, 820),
  Map<String, Object> prefs = const {},
  List extra = const [],
  String role = 'manager',
}) async {
  _size(tester, size);
  await tester.pumpWidget(await themed(
    child,
    prefs: prefs,
    overrides: [
      ...vpOverrides(vendors: vendors, products: products, tickets: tickets, permissions: permissions, role: role),
      ...extra,
    ],
  ));
  await tester.pump();
  await tester.pump();
}

/// Like [pumpVp], inside a [GoRouter] so screens can follow links.
Future<void> pumpVpRouter(
  WidgetTester tester,
  GoRouter router, {
  required List overrides,
  Size size = const Size(400, 900),
  Map<String, Object> prefs = const {},
}) async {
  _size(tester, size);
  GoogleFonts.config.allowRuntimeFetching = false;
  SharedPreferences.setMockInitialValues(prefs);
  final p = await SharedPreferences.getInstance();
  await tester.pumpWidget(ProviderScope(
    overrides: [prefsProvider.overrideWithValue(p), ...overrides.cast()],
    child: MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router),
  ));
  await tester.pump();
  await tester.pump();
}
