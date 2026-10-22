import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/widgets/zone_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'fakes/fake_finance_repository.dart';
import 'fakes/fake_orders_repository.dart';
import 'fakes/fake_rider_repositories.dart';
import 'fakes/fake_vendor_product_repositories.dart';
import 'helpers.dart';
import 'vp_helpers.dart' show MeWith, pumpVpRouter;

const financeViewer = {'manager.finance.view', 'manager.reports.view'};

/// The fakes one finance-side test uses.
class FinanceFakes {
  FinanceFakes({
    FakeFinanceRepository? finance,
    FakeReportsRepository? reports,
    FakePaymentsRepository? payments,
    FakeVendorsRepository? vendors,
    FakeRidersRepository? riders,
    FakeOrdersRepository? orders,
  })  : finance = finance ?? FakeFinanceRepository(),
        orders = orders ?? FakeOrdersRepository(),
        reports = reports ?? FakeReportsRepository(),
        payments = payments ?? FakePaymentsRepository(),
        vendors = vendors ?? FakeVendorsRepository(),
        riders = riders ?? FakeRidersRepository();

  final FakeFinanceRepository finance;
  final FakeReportsRepository reports;
  final FakePaymentsRepository payments;
  final FakeVendorsRepository vendors;
  final FakeRidersRepository riders;
  final FakeOrdersRepository orders;

  List overrides(Set<String> permissions, {String role = 'manager'}) => [
        financeRepoProvider.overrideWithValue(finance),
        reportsRepoProvider.overrideWithValue(reports),
        paymentsRepoProvider.overrideWithValue(payments),
        vendorsRepoProvider.overrideWithValue(vendors),
        ridersRepoProvider.overrideWithValue(riders),
        ordersRepoProvider.overrideWithValue(orders),
        managerMeProvider.overrideWith(() => MeWith(permissions, role)),
        activeZoneProvider.overrideWithValue(null),
        signedInProvider.overrideWithValue(true),
      ];
}

Future<void> pumpFinance(
  WidgetTester tester,
  Widget child, {
  FinanceFakes? fakes,
  Set<String> permissions = financeViewer,
  Size size = const Size(400, 1400),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(await themed(child, overrides: (fakes ?? FinanceFakes()).overrides(permissions)));
  await tester.pump();
  await tester.pump();
}

/// [child] at `/start` inside a router that records every other path opened.
Future<List<String>> pumpFinanceRouter(
  WidgetTester tester,
  Widget Function(GoRouterState) child, {
  FinanceFakes? fakes,
  Set<String> permissions = financeViewer,
  Size size = const Size(400, 1400),
}) async {
  final opened = <String>[];
  final router = GoRouter(
    initialLocation: '/start',
    routes: [
      GoRoute(path: '/start', builder: (_, s) => child(s)),
      GoRoute(
        path: '/:rest(.*)',
        builder: (_, s) {
          final u = s.uri.toString();
          if (opened.isEmpty || opened.last != u) opened.add(u);
          return Scaffold(body: Text('opened ${s.uri}'));
        },
      ),
    ],
  );
  await pumpVpRouter(tester, router, overrides: (fakes ?? FinanceFakes()).overrides(permissions), size: size);
  return opened;
}
