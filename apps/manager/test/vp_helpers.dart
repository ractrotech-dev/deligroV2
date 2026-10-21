import 'package:deligro_manager/features/orders/order_mini_map.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/widgets/zone_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'auth_test.dart' show meJson;
import 'fakes/fake_vendor_product_repositories.dart';
import 'helpers.dart';

/// A manager in one zone with exactly [permissions] on.
class MeWith extends ManagerMeNotifier {
  MeWith(this.permissions);
  final Set<String> permissions;

  @override
  Future<ManagerMe?> build() async => ManagerMe.fromJson({
        ...meJson,
        'permissions': {for (final p in permissions) p: true},
      });
}

const vendorViewer = {'manager.vendors.view', 'manager.support.manage', 'manager.orders.view', 'manager.reports.view'};
const productViewer = {'manager.products.view', 'manager.vendors.view'};

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
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(await themed(
    child,
    prefs: prefs,
    overrides: [
      vendorsRepoProvider.overrideWithValue(vendors ?? FakeVendorsRepository()),
      productsRepoProvider.overrideWithValue(products ?? FakeProductsRepository()),
      ticketsRepoProvider.overrideWithValue(tickets ?? FakeTicketsRepository()),
      managerMeProvider.overrideWith(() => MeWith(permissions)),
      activeZoneProvider.overrideWithValue(null),
      signedInProvider.overrideWithValue(true),
      mapTilesEnabledProvider.overrideWithValue(false),
    ],
  ));
  await tester.pump();
  await tester.pump();
}
