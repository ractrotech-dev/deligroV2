// Phase 7 screenshots (marketing, offers, customers) with sample data, for
// reviewing the look without a signed-in manager. Like screens_test.dart it
// lives outside test/ and is not a regression gate. Writes PNGs to
// test_screens/out/ (gitignored):
//
//   flutter test test_screens/phase7_screens_test.dart --update-goldens
import 'dart:io';

import 'package:deligro_manager/features/customers/customer_detail_screen.dart';
import 'package:deligro_manager/features/customers/customers_screen.dart';
import 'package:deligro_manager/features/customers/retention_screen.dart';
import 'package:deligro_manager/features/marketing/campaign_detail_screen.dart';
import 'package:deligro_manager/features/marketing/campaign_form_screen.dart';
import 'package:deligro_manager/features/marketing/marketing_screen.dart';
import 'package:deligro_manager/features/marketing/request_decide_screen.dart';
import 'package:deligro_manager/features/offers/offer_detail_screen.dart';
import 'package:deligro_manager/features/offers/offer_form_screen.dart';
import 'package:deligro_manager/features/offers/offers_screen.dart';
import 'package:deligro_manager/features/orders/order_mini_map.dart';
import 'package:deligro_manager/models/customers.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/models/marketing.dart';
import 'package:deligro_manager/models/offers.dart';
import 'package:deligro_manager/state/customers.dart';
import 'package:deligro_manager/state/marketing.dart';
import 'package:deligro_manager/state/offers.dart';
import 'package:deligro_manager/state/prefs.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/theme/app_theme.dart';
import 'package:deligro_manager/widgets/zone_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/auth_test.dart' show meJson;
import '../test/fakes/fake_marketing_offers_customers.dart';
import '../test/fakes/fake_vendor_product_repositories.dart';

Future<void> _loadFont(String family, List<String> files) async {
  final loader = FontLoader(family);
  for (final f in files) {
    final bytes = File(f.contains('/') ? f : 'C:/Windows/Fonts/$f').readAsBytesSync();
    loader.addFont(Future.value(ByteData.view(bytes.buffer)));
  }
  await loader.load();
}

Future<void> _fonts() async {
  for (final w in FontWeight.values) {
    final bold = w.value >= 600;
    await _loadFont(GoogleFonts.inter(fontWeight: w).fontFamily!, [bold ? 'segoeuib.ttf' : 'segoeui.ttf']);
    await _loadFont(GoogleFonts.jetBrainsMono(fontWeight: w).fontFamily!, [bold ? 'consolab.ttf' : 'consola.ttf']);
  }
  await _loadFont('Roboto', ['segoeui.ttf', 'segoeuib.ttf']);
  await _loadFont('MaterialIcons', ['F:/dev/flutter/bin/cache/artifacts/material_fonts/materialicons-regular.otf']);
}

class _FixedMe extends ManagerMeNotifier {
  @override
  Future<ManagerMe?> build() async => ManagerMe.fromJson({
        ...meJson,
        'permissions': {
          'manager.marketing.manage': true,
          'manager.offers.manage': true,
          'manager.customers.view': true,
          'manager.customers.contact': true,
          'manager.customers.suspend': true,
          'manager.vendors.view': true,
          'manager.products.view': true,
          'manager.finance.view': true,
          'manager.support.manage': true,
        },
      });
}

/// Fakes whose lists are last pages, so no load-more spinner keeps animating.
(FakeMarketingRepository, FakeOffersRepository, FakeCustomersRepository) _fakes() {
  final m = FakeMarketingRepository();
  m.requestPage = MarketingRequestPage(items: m.requestPage.items.take(2).toList(), counts: m.requestPage.counts);
  m.campaignPage = CampaignPage(items: m.campaignPage.items.take(2).toList(), counts: m.campaignPage.counts);
  final o = FakeOffersRepository();
  final c = FakeCustomersRepository();
  c.page = CustomerPage(items: c.page.items.take(2).toList());
  return (m, o, c);
}

Future<void> _pump(WidgetTester t, Widget child, {Brightness b = Brightness.light, Size size = const Size(390, 860)}) async {
  t.view.physicalSize = size * 2;
  t.view.devicePixelRatio = 2;
  addTearDown(t.view.reset);
  // A test harness outside test/, so the analyzer does not know it is one.
  // ignore: invalid_use_of_visible_for_testing_member
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  final (m, o, c) = _fakes();
  await t.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      managerMeProvider.overrideWith(_FixedMe.new),
      signedInProvider.overrideWithValue(true),
      activeZoneProvider.overrideWithValue(null),
      marketingRepoProvider.overrideWithValue(m),
      offersRepoProvider.overrideWithValue(o),
      customersRepoProvider.overrideWithValue(c),
      vendorsRepoProvider.overrideWithValue(FakeVendorsRepository()),
      productsRepoProvider.overrideWithValue(FakeProductsRepository()),
      mapTilesEnabledProvider.overrideWithValue(false),
    ],
    child: MaterialApp(debugShowCheckedModeBanner: false, theme: buildTheme(b), home: child),
  ));
  for (var i = 0; i < 10; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _shot(WidgetTester t, String name) => expectLater(find.byType(MaterialApp).first, matchesGoldenFile('out/$name.png'));

RequestBundle _featured() =>
    RequestBundle(request: MarketingRequest.fromJson((p7('marketing_requests')['items'] as List).first as Map<String, dynamic>));

void main() {
  setUpAll(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await _fonts();
  });

  for (final b in Brightness.values) {
    final tag = b.name;
    testWidgets('p7 marketing requests $tag', (t) async {
      await _pump(t, MarketingScreen(query: Uri.parse('/more/marketing?status=pending')), b: b);
      await _shot(t, 'p7-marketing-requests-$tag');
    });
    testWidgets('p7 offers $tag', (t) async {
      await _pump(t, const OffersScreen(), b: b);
      await _shot(t, 'p7-offers-$tag');
    });
    testWidgets('p7 customer detail $tag', (t) async {
      await _pump(t, const CustomerDetailScreen(customerId: 'c-1'), b: b);
      await _shot(t, 'p7-customer-detail-$tag');
    });
  }

  testWidgets('p7 campaigns tab', (t) async {
    await _pump(t, MarketingScreen(query: Uri.parse('/more/marketing?tab=campaigns&state=active')));
    await _shot(t, 'p7-campaigns');
  });
  testWidgets('p7 campaign detail', (t) async {
    await _pump(t, const CampaignDetailScreen(campaignId: 'c-2'));
    await _shot(t, 'p7-campaign-detail');
  });
  testWidgets('p7 campaign form', (t) async {
    await _pump(t, CampaignFormScreen(edit: CampaignBundle.fromJson(p7('campaign_detail')).campaign));
    await _shot(t, 'p7-campaign-form');
  });
  testWidgets('p7 approve request', (t) async {
    await _pump(t, RequestDecideScreen(bundle: _featured()));
    await _shot(t, 'p7-request-decide');
  });
  testWidgets('p7 offer detail', (t) async {
    await _pump(t, const OfferDetailScreen(code: 'DIWALI50'));
    await _shot(t, 'p7-offer-detail');
  });
  testWidgets('p7 offer form', (t) async {
    await _pump(t, OfferFormScreen(edit: OfferBundle.fromJson(p7('offer_detail')).offer));
    await _shot(t, 'p7-offer-form');
  });
  testWidgets('p7 customers', (t) async {
    await _pump(t, const CustomersScreen());
    await _shot(t, 'p7-customers');
  });
  testWidgets('p7 retention', (t) async {
    await _pump(t, const RetentionScreen());
    await _shot(t, 'p7-retention');
  });
  testWidgets('p7 marketing tablet', (t) async {
    await _pump(t, MarketingScreen(query: Uri.parse('/more/marketing?status=pending')), size: const Size(900, 700));
    await _shot(t, 'p7-marketing-tablet');
  });
  testWidgets('p7 customers tablet', (t) async {
    await _pump(t, const CustomersScreen(), size: const Size(900, 700));
    await _shot(t, 'p7-customers-tablet');
  });
}
