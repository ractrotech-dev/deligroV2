import 'package:deligro_manager/features/orders/order_mini_map.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/widgets/zone_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'fakes/fake_orders_repository.dart';
import 'fakes/fake_rider_repositories.dart';
import 'fakes/fake_vendor_product_repositories.dart';
import 'helpers.dart';
import 'vp_helpers.dart' show MeWith, pumpVpRouter;

const riderViewer = {'manager.riders.view', 'manager.orders.view', 'manager.support.manage', 'manager.live.view'};

/// The fakes one rider-side test uses; any left null get a default.
class RiderFakes {
  RiderFakes({
    FakeRidersRepository? riders,
    FakePaymentsRepository? payments,
    FakeCashRepository? cash,
    FakeExceptionsRepository? exceptions,
    FakeOrdersRepository? orders,
  })  : riders = riders ?? FakeRidersRepository(),
        payments = payments ?? FakePaymentsRepository(),
        cash = cash ?? FakeCashRepository(),
        exceptions = exceptions ?? FakeExceptionsRepository(),
        orders = orders ?? FakeOrdersRepository();

  final FakeRidersRepository riders;
  final FakePaymentsRepository payments;
  final FakeCashRepository cash;
  final FakeExceptionsRepository exceptions;
  final FakeOrdersRepository orders;

  List overrides(Set<String> permissions) => [
        ridersRepoProvider.overrideWithValue(riders),
        paymentsRepoProvider.overrideWithValue(payments),
        cashRepoProvider.overrideWithValue(cash),
        exceptionsRepoProvider.overrideWithValue(exceptions),
        ordersRepoProvider.overrideWithValue(orders),
        ticketsRepoProvider.overrideWithValue(FakeTicketsRepository()),
        managerMeProvider.overrideWith(() => MeWith(permissions)),
        activeZoneProvider.overrideWithValue(null),
        signedInProvider.overrideWithValue(true),
        mapTilesEnabledProvider.overrideWithValue(false),
      ];
}

/// Pumps [child] with fake rider-side repositories.
Future<void> pumpRider(
  WidgetTester tester,
  Widget child, {
  RiderFakes? fakes,
  Set<String> permissions = riderViewer,
  Size size = const Size(400, 900),
  Map<String, Object> prefs = const {},
  List extra = const [],
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(await themed(
    child,
    prefs: prefs,
    overrides: [...(fakes ?? RiderFakes()).overrides(permissions), ...extra],
  ));
  await tester.pump();
  await tester.pump();
}

/// [child] at `/start` inside a router that records every other path opened.
Future<List<String>> pumpRiderRouter(
  WidgetTester tester,
  Widget Function(GoRouterState) child, {
  RiderFakes? fakes,
  Set<String> permissions = riderViewer,
  String start = '/start',
  Size size = const Size(400, 900),
  List extra = const [],
}) async {
  final opened = <String>[];
  final router = GoRouter(
    initialLocation: start,
    routes: [
      GoRoute(path: '/start', builder: (_, s) => child(s)),
      GoRoute(path: '/more/riders', builder: (_, s) => child(s)),
      GoRoute(
        path: '/:rest(.*)',
        builder: (_, s) {
          opened.add(s.uri.toString());
          return Scaffold(body: Text('opened ${s.uri}'));
        },
      ),
    ],
  );
  await pumpVpRouter(
    tester,
    router,
    overrides: [...(fakes ?? RiderFakes()).overrides(permissions), ...extra],
    size: size,
  );
  return opened;
}
