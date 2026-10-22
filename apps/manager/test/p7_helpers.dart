import 'package:deligro_manager/state/customers.dart';
import 'package:deligro_manager/state/marketing.dart';
import 'package:deligro_manager/state/offers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_marketing_offers_customers.dart';
import 'fakes/fake_vendor_product_repositories.dart';
import 'helpers.dart';
import 'vp_helpers.dart';

const marketer = {'manager.marketing.manage', 'manager.offers.manage', 'manager.customers.view', 'manager.vendors.view', 'manager.products.view'};

/// Pumps [child] with fake marketing, offers and customers repositories
/// (and Phase 4's vendor/product fakes for the pickers).
Future<void> pumpP7(
  WidgetTester tester,
  Widget child, {
  FakeMarketingRepository? marketing,
  FakeOffersRepository? offers,
  FakeCustomersRepository? customers,
  Set<String> permissions = marketer,
  Size size = const Size(390, 860),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(await themed(child, overrides: [
    ...vpOverrides(permissions: permissions, products: FakeProductsRepository()),
    marketingRepoProvider.overrideWithValue(marketing ?? FakeMarketingRepository()),
    offersRepoProvider.overrideWithValue(offers ?? FakeOffersRepository()),
    customersRepoProvider.overrideWithValue(customers ?? FakeCustomersRepository()),
  ]));
  await tester.pump();
  await tester.pump();
}

/// Lets async work and animations run without waiting for an endless
/// spinner (a list with more pages shows one at its foot).
Future<void> settle(WidgetTester tester, [int frames = 12]) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}
