// Screenshots of the Manager app's screens with sample data, for
// reviewing the look without a signed-in manager. Not part of `flutter test`
// (it lives outside test/) and not a regression gate: the images depend on
// this PC's fonts. Writes PNGs to test_screens/out/ (gitignored):
//
//   flutter test test_screens --update-goldens
//
// Text uses Segoe UI / Consolas from C:\Windows\Fonts in place of Inter /
// JetBrains Mono, so the layout is real; Hindi glyphs are not available here.
import 'dart:io';

import 'package:deligro_manager/features/home/home_screen.dart';
import 'package:deligro_manager/features/live/live_screen.dart';
import 'package:deligro_manager/features/orders/order_detail_screen.dart';
import 'package:deligro_manager/features/orders/order_mini_map.dart';
import 'package:deligro_manager/features/orders/orders_screen.dart';
import 'package:deligro_manager/features/stats/stats_screen.dart';
import 'package:deligro_manager/models/dashboard.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/models/orders.dart';
import 'package:deligro_manager/models/stats.dart';
import 'package:deligro_manager/state/dashboard.dart';
import 'package:deligro_manager/state/prefs.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/state/stats.dart';
import 'package:deligro_manager/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:deligro_manager/features/products/product_detail_screen.dart';
import 'package:deligro_manager/features/products/product_insights_screen.dart';
import 'package:deligro_manager/features/products/products_screen.dart';
import 'package:deligro_manager/features/support/ticket_thread_screen.dart';
import 'package:deligro_manager/features/vendors/onboard/onboard_flow.dart';
import 'package:deligro_manager/features/vendors/vendor_detail_screen.dart';
import 'package:deligro_manager/features/vendors/vendors_screen.dart';
import 'package:deligro_manager/models/vendors.dart';
import 'package:deligro_manager/state/onboard_draft.dart';
import 'package:latlong2/latlong.dart';

import 'package:deligro_manager/features/cash/cash_screen.dart';
import 'package:deligro_manager/features/live/exceptions_screen.dart';
import 'package:deligro_manager/features/payments/approvals_screen.dart';
import 'package:deligro_manager/features/riders/rider_detail_screen.dart';
import 'package:deligro_manager/features/riders/rider_ledger_screen.dart';
import 'package:deligro_manager/features/riders/rider_onboard_screen.dart';
import 'package:deligro_manager/features/riders/riders_screen.dart';
import 'package:deligro_manager/models/rider.dart';

import 'package:deligro_manager/features/finance/finance_screen.dart';
import 'package:deligro_manager/features/finance/issues_screen.dart';
import 'package:deligro_manager/features/finance/reconciliation_screen.dart';
import 'package:deligro_manager/features/finance/refunds_screen.dart';
import 'package:deligro_manager/features/finance/settlement_detail_screen.dart';
import 'package:deligro_manager/features/finance/settlements_screen.dart';
import 'package:deligro_manager/features/finance/vendor_dues_screen.dart';
import 'package:deligro_manager/features/reports/report_view.dart';
import 'package:deligro_manager/features/reports/reports_screen.dart';
import 'package:deligro_manager/models/payment_request.dart';

import '../test/auth_test.dart' show meJson;
import '../test/fakes/fake_finance_repository.dart';
import '../test/fakes/fake_rider_repositories.dart';
import '../test/fakes/fake_vendor_product_repositories.dart';
import '../test/fakes/fake_orders_repository.dart';
import '../test/fixtures/fixtures.dart';
import '../test/stats_fixture.dart';

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
          'manager.reports.view': true,
          'manager.finance.view': true,
          'manager.orders.view': true,
          'manager.live.view': true,
          'manager.move_status': true,
          'manager.assign_rider': true,
          'manager.reassign_rider': true,
          'manager.orders.escalate': true,
          'manager.orders.correct': true,
          'manager.vendors.view': true,
          'manager.vendors.status': true,
          'manager.vendors.onboard': true,
          'manager.support.manage': true,
          'manager.products.view': true,
          'manager.products.moderate': true,
          'manager.riders.view': true,
          'manager.riders.status': true,
          'manager.riders.onboard': true,
          'manager.finance.adjust': true,
          'manager.finance.initiate_payment': true,
          'manager.finance.approve_payment': true,
          'manager.cash': true,
          'manager.exceptions.decide': true,
        },
      });
}

class _FixedDashboard extends DashboardNotifier {
  @override
  Future<DashboardData> build() async => DashboardData.fromJson({
        'today': '2026-10-21',
        'generatedAt': DateTime.now().toUtc().toIso8601String(),
        'order': [for (final f in FigureKey.values) f.key],
        'figures': {
          'todaysTotalSales': 18640, 'totalSales': 1284560, 'todaysOrders': 74, 'totalOrders': 5231,
          'pendingOrders': 9, 'completedOrders': 5038, 'cancelledOrders': 184, 'activeVendors': 42,
          'onlineVendors': 31, 'activeRiders': 18, 'onlineRiders': 11, 'ridersOnDelivery': 6,
          'totalDeliveryFees': 142300, 'totalPlatformCommission': 186420, 'vendorPaymentsDue': 64210,
          'riderPaymentsDue': null, 'pendingMarketingRequests': null, 'pendingSupportTickets': null,
        },
        'unavailable': ['riderPaymentsDue', 'pendingMarketingRequests', 'pendingSupportTickets'],
      });
}

Future<void> _pump(WidgetTester t, Widget child,
    {Brightness b = Brightness.light, Size size = const Size(390, 860), FakePaymentsRepository? payments}) async {
  t.view.physicalSize = size * 2;
  t.view.devicePixelRatio = 2;
  addTearDown(t.view.reset);
  // A test harness outside test/, so the analyzer does not know it is one.
  // ignore: invalid_use_of_visible_for_testing_member
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  await t.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      managerMeProvider.overrideWith(_FixedMe.new),
      dashboardProvider.overrideWith(_FixedDashboard.new),
      statsProvider.overrideWith((_) async => StatsData.fromJson(statsJson())),
      signedInProvider.overrideWithValue(true),
      // The last page (no cursor), so no load-more spinner keeps animating.
      ordersRepoProvider.overrideWithValue(
          FakeOrdersRepository(page: OrderPage(
        items: OrderPage.fromJson(apiFixture('orders_list')).items,
        counts: const QueueCounts(delayed: 2, unassigned: 1),
      ))),
      liveRepoProvider.overrideWithValue(FakeLiveRepository()),
      // Last pages (no cursor), so no load-more spinner keeps animating.
      vendorsRepoProvider.overrideWithValue(FakeVendorsRepository(
          page: VendorPage(
        items: VendorPage.fromJson(apiFixture('vendors_list')).items,
        counts: VendorPage.fromJson(apiFixture('vendors_list')).counts,
      ))),
      productsRepoProvider.overrideWithValue(FakeProductsRepository()),
      // The last page (no cursor), so no load-more spinner keeps animating.
      ridersRepoProvider.overrideWithValue(FakeRidersRepository(
          page: RiderPage(
        items: RiderPage.fromJson(p5('riders_list')).items,
        counts: RiderPage.fromJson(p5('riders_list')).counts,
      ))),
      paymentsRepoProvider.overrideWithValue(payments ?? FakePaymentsRepository()),
      cashRepoProvider.overrideWithValue(FakeCashRepository()),
      exceptionsRepoProvider.overrideWithValue(FakeExceptionsRepository()),
      ticketsRepoProvider.overrideWithValue(FakeTicketsRepository()),
      financeRepoProvider.overrideWithValue(FakeFinanceRepository()),
      reportsRepoProvider.overrideWithValue(FakeReportsRepository()),
      currentLocationProvider.overrideWithValue(() async => const LatLng(21.7151, 81.5338)),
      // No network here: maps draw their pins on the plain map colour.
      mapTilesEnabledProvider.overrideWithValue(false),
    ],
    child: MaterialApp(debugShowCheckedModeBanner: false, theme: buildTheme(b), home: child),
  ));
  await t.pumpAndSettle();
}

Future<void> _shot(WidgetTester t, String name) =>
    expectLater(find.byType(MaterialApp).first, matchesGoldenFile('out/$name.png'));

void main() {
  setUpAll(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await _fonts();
  });

  for (final b in Brightness.values) {
    testWidgets('home dashboard ($b)', (t) async {
      await _pump(t, const HomeScreen(), b: b, size: const Size(390, 1500));
      await _shot(t, 'home-${b.name}');
    });
  }

  testWidgets('home dashboard, tablet', (t) async {
    await _pump(t, const HomeScreen(), size: const Size(1024, 900));
    await _shot(t, 'home-tablet');
  });

  testWidgets('statistics', (t) async {
    await _pump(t, const StatsScreen(), size: const Size(390, 3400));
    await _shot(t, 'stats-light');
  });

  const orderId = 'cd34ef56-0000-4000-8000-000000000002';
  for (final b in Brightness.values) {
    testWidgets('orders list ($b)', (t) async {
      await _pump(t, const OrdersScreen(), b: b, size: const Size(390, 1500));
      await _shot(t, 'orders-${b.name}');
    });
    testWidgets('order detail ($b)', (t) async {
      await _pump(t, const OrderDetailScreen(orderId: orderId), b: b, size: const Size(390, 2300));
      await _shot(t, 'order-detail-${b.name}');
    });
    testWidgets('live ($b)', (t) async {
      await _pump(t, const LiveScreen(), b: b);
      await _shot(t, 'live-${b.name}');
    });
  }

  testWidgets('orders, tablet (list + detail)', (t) async {
    await _pump(t, const OrdersScreen(), size: const Size(1280, 900));
    await t.tap(find.byKey(const Key('order-tile-$orderId')));
    await t.pumpAndSettle();
    await _shot(t, 'orders-tablet');
  });

  testWidgets('live, tablet', (t) async {
    await _pump(t, const LiveScreen(), size: const Size(1280, 860));
    await _shot(t, 'live-tablet');
  });

  for (final b in Brightness.values) {
    testWidgets('vendors list ($b)', (t) async {
      await _pump(t, const VendorsScreen(), b: b, size: const Size(390, 1100));
      await _shot(t, 'vendors-${b.name}');
    });
    testWidgets('vendor detail, overview ($b)', (t) async {
      await _pump(t, const VendorDetailScreen(vendorId: 'v-1'), b: b, size: const Size(390, 2400));
      await _shot(t, 'vendor-overview-${b.name}');
    });
    testWidgets('vendor detail, documents ($b)', (t) async {
      await _pump(t, const VendorDetailScreen(vendorId: 'v-1'), b: b, size: const Size(390, 1100));
      await t.tap(find.widgetWithText(Tab, 'Documents'));
      await t.pumpAndSettle();
      await _shot(t, 'vendor-documents-${b.name}');
    });
    testWidgets('onboarding, location step ($b)', (t) async {
      await _pump(t, const OnboardFlow(), b: b, size: const Size(390, 1100));
      await t.enterText(find.byKey(const Key('onboard-shop-name')), 'Green Leaf Cafe');
      await t.pump();
      await t.tap(find.byKey(const Key('onboard-next')));
      await t.pumpAndSettle();
      await t.enterText(find.byKey(const Key('onboard-owner-name')), 'Meena Sahu');
      await t.enterText(find.byKey(const Key('onboard-mobile')), '9812345678');
      await t.enterText(find.byKey(const Key('onboard-email')), 'meena@greenleaf.in');
      await t.pump();
      await t.tap(find.byKey(const Key('onboard-next')));
      await t.pumpAndSettle();
      await t.enterText(find.byKey(const Key('onboard-address')), 'Gandhi Chowk, Bemetara');
      await t.tap(find.byKey(const Key('onboard-use-location')));
      await t.pumpAndSettle();
      await _shot(t, 'onboard-location-${b.name}');
    });
    testWidgets('ticket thread ($b)', (t) async {
      await _pump(t, const TicketThreadScreen(ticketId: 't-1'), b: b, size: const Size(390, 900));
      await _shot(t, 'ticket-${b.name}');
    });
    testWidgets('products list ($b)', (t) async {
      await _pump(t, const ProductsScreen(), b: b, size: const Size(390, 1100));
      await _shot(t, 'products-${b.name}');
    });
    testWidgets('product detail ($b)', (t) async {
      await _pump(t, const ProductDetailScreen(productId: 'p-1'), b: b, size: const Size(390, 2600));
      await _shot(t, 'product-detail-${b.name}');
    });
    testWidgets('product insights ($b)', (t) async {
      await _pump(t, const ProductInsightsScreen(), b: b, size: const Size(390, 1500));
      await _shot(t, 'product-insights-${b.name}');
    });
  }

  testWidgets('vendors, tablet (list + detail)', (t) async {
    await _pump(t, const VendorsScreen(), size: const Size(1280, 900));
    await t.tap(find.text('Spice Hub'));
    await t.pumpAndSettle();
    await _shot(t, 'vendors-tablet');
  });

  testWidgets('products, tablet (list + detail)', (t) async {
    await _pump(t, const ProductsScreen(), size: const Size(1280, 900));
    await t.tap(find.text('Paneer Tikka'));
    await t.pumpAndSettle();
    await _shot(t, 'products-tablet');
  });

  // ── Phase 5: riders, approvals, cash, exceptions ──────────────────────────

  for (final b in Brightness.values) {
    testWidgets('riders list ($b)', (t) async {
      await _pump(t, const RidersScreen(), b: b, size: const Size(390, 1000));
      await _shot(t, 'riders-${b.name}');
    });
    testWidgets('rider detail, overview ($b)', (t) async {
      await _pump(t, const RiderDetailScreen(riderId: 'r-1'), b: b, size: const Size(390, 1900));
      await _shot(t, 'rider-overview-${b.name}');
    });
    testWidgets('approvals ($b)', (t) async {
      await _pump(t, const ApprovalsScreen(), b: b, size: const Size(390, 1100));
      await _shot(t, 'approvals-${b.name}');
    });
    testWidgets('exceptions queue ($b)', (t) async {
      await _pump(t, const ExceptionsScreen(), b: b, size: const Size(390, 1200));
      await _shot(t, 'exceptions-${b.name}');
    });
  }

  Future<void> riderTab(WidgetTester t, String tab, String name, {double height = 1300}) async {
    await _pump(t, const RiderDetailScreen(riderId: 'r-1'), size: Size(390, height));
    await t.ensureVisible(find.widgetWithText(Tab, tab));
    await t.pumpAndSettle();
    await t.tap(find.widgetWithText(Tab, tab));
    await t.pumpAndSettle();
    await _shot(t, name);
  }

  testWidgets('rider detail, documents', (t) => riderTab(t, 'Documents', 'rider-documents'));
  testWidgets('rider detail, performance', (t) => riderTab(t, 'Performance', 'rider-performance', height: 1500));
  testWidgets('rider detail, money', (t) => riderTab(t, 'Money', 'rider-money'));
  testWidgets('rider detail, cash', (t) => riderTab(t, 'Cash', 'rider-cash'));
  testWidgets('rider detail, deliveries', (t) => riderTab(t, 'Deliveries', 'rider-deliveries'));

  testWidgets('rider onboarding, first step', (t) async {
    await _pump(t, const RiderOnboardScreen(), size: const Size(390, 900));
    await t.enterText(find.byKey(const Key('rider-name')), 'Ravi Kumar');
    await t.enterText(find.byKey(const Key('rider-mobile')), '98765432');
    await t.pumpAndSettle();
    await _shot(t, 'rider-onboard');
  });

  testWidgets('rider ledger', (t) async {
    await _pump(t, const RiderLedgerScreen(riderId: 'r-1'), size: const Size(390, 1000));
    await _shot(t, 'rider-ledger');
  });

  testWidgets('cash deposits', (t) async {
    await _pump(t, const CashScreen(), size: const Size(390, 1000));
    await _shot(t, 'cash');
  });

  testWidgets('riders, tablet (list + detail)', (t) async {
    await _pump(t, RidersScreen(detailPane: (id) => RiderDetailBody(riderId: id)), size: const Size(1280, 900));
    await t.tap(find.text('Ravi Kumar'));
    await t.pumpAndSettle();
    await _shot(t, 'riders-tablet');
  });

  // ── Phase 6: finance and reports ──────────────────────────────────────────

  for (final b in Brightness.values) {
    testWidgets('finance overview ($b)', (t) async {
      await _pump(t, const FinanceScreen(), b: b, size: const Size(390, 1900));
      await _shot(t, 'finance-${b.name}');
    });
    testWidgets('settlement detail ($b)', (t) async {
      await _pump(t, const SettlementDetailScreen(settlementId: 's-2'), b: b, size: const Size(390, 1500));
      await _shot(t, 'settlement-detail-${b.name}');
    });
    testWidgets('reconciliation ($b)', (t) async {
      await _pump(t, const ReconciliationScreen(), b: b, size: const Size(390, 1000));
      await _shot(t, 'reconciliation-${b.name}');
    });
    testWidgets('report view ($b)', (t) async {
      await _pump(t, const ReportViewScreen(kind: 'sales'), b: b, size: const Size(390, 1000));
      await _shot(t, 'report-${b.name}');
    });
  }

  testWidgets('finance overview, tablet', (t) async {
    await _pump(t, const FinanceScreen(), size: const Size(1280, 1300));
    await _shot(t, 'finance-tablet');
  });
  testWidgets('vendor dues', (t) async {
    await _pump(t, const VendorDuesScreen(), size: const Size(390, 1000));
    await _shot(t, 'vendor-dues');
  });
  testWidgets('failed and delayed', (t) async {
    await _pump(t, const IssuesScreen(), size: const Size(390, 1900));
    await _shot(t, 'finance-issues');
  });
  testWidgets('settlement history', (t) async {
    await _pump(t, const SettlementsScreen(), size: const Size(390, 1000));
    await _shot(t, 'settlements');
  });
  testWidgets('settlements, tablet (list + detail)', (t) async {
    await _pump(t, const SettlementsScreen(), size: const Size(1280, 1000));
    await t.tap(find.text('Green Leaf Cafe'));
    await t.pumpAndSettle();
    await _shot(t, 'settlements-tablet');
  });
  testWidgets('approvals with a settlement card', (t) async {
    await _pump(t, const ApprovalsScreen(),
        payments: FakePaymentsRepository(page: PaymentRequestPage.fromJson(p6('payment_requests_settlement'))),
        size: const Size(390, 1000));
    await _shot(t, 'approvals-settlements');
  });
  testWidgets('refunds', (t) async {
    await _pump(t, const RefundsScreen(), size: const Size(390, 1000));
    await _shot(t, 'refunds');
  });
  testWidgets('reports picker', (t) async {
    await _pump(t, const ReportsScreen(), size: const Size(390, 1100));
    await _shot(t, 'reports');
  });
  testWidgets('report export sheet', (t) async {
    await _pump(t, const ReportViewScreen(kind: 'sales'), size: const Size(390, 900));
    await t.tap(find.byKey(const Key('report-export')));
    await t.pumpAndSettle();
    await _shot(t, 'report-export');
  });
  testWidgets('report view, tablet', (t) async {
    await _pump(t, const ReportViewScreen(kind: 'sales'), size: const Size(1280, 900));
    await _shot(t, 'report-tablet');
  });
}
