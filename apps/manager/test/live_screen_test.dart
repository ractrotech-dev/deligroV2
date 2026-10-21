import 'package:deligro_manager/core/push.dart';
import 'package:deligro_manager/features/live/live_screen.dart';
import 'package:deligro_manager/features/orders/order_mini_map.dart';
import 'package:deligro_manager/models/live.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/models/orders.dart';
import 'package:deligro_manager/state/prefs.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'auth_test.dart' show meJson;
import 'fakes/fake_orders_repository.dart';
import 'fixtures/fixtures.dart';
import 'helpers.dart';

class _FixedMe extends ManagerMeNotifier {
  @override
  Future<ManagerMe?> build() async => ManagerMe.fromJson({
        ...meJson,
        'permissions': {
          'manager.live.view': true,
          'manager.orders.view': true,
          'manager.move_status': true,
          'manager.assign_rider': true,
          'manager.reassign_rider': true,
          'manager.orders.escalate': true,
          'manager.orders.correct': true,
        },
      });
}

class _Harness {
  _Harness(this.live, this.orders, this.paths);
  final FakeLiveRepository live;
  final FakeOrdersRepository orders;
  final List<String> paths;
}

Future<_Harness> _screen(WidgetTester tester, {Size size = const Size(390, 860), Uri? query, LiveSnapshot? snapshot}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final live = FakeLiveRepository(snapshot: snapshot);
  final orders = FakeOrdersRepository();
  final paths = <String>[];
  await tester.pumpWidget(const SizedBox());
  await tester.pumpWidget(await themed(LiveScreen(query: query, onNavigate: paths.add), overrides: [
    liveRepoProvider.overrideWithValue(live),
    ordersRepoProvider.overrideWithValue(orders),
    managerMeProvider.overrideWith(_FixedMe.new),
    signedInProvider.overrideWithValue(true),
    mapTilesEnabledProvider.overrideWithValue(false),
  ]));
  await _settle(tester);
  return _Harness(live, orders, paths);
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _section(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(Key('live-section-$key')));
  await tester.pump();
  await tester.tap(find.byKey(Key('live-section-$key')));
  await _settle(tester);
}

void main() {
  const ravi = '33333333-3333-4333-8333-333333333301';
  const deepak = '33333333-3333-4333-8333-333333333303';

  testWidgets('a stale rider is grey and says how old the location is', (tester) async {
    await _screen(tester);
    final pin = tester.widget<MapPin>(find.descendant(of: find.byKey(const Key('rider-marker-$ravi')), matching: find.byType(MapPin)));
    expect(pin.color, AppColors.light.muted);
    expect(find.text('updated 9 min ago'), findsOneWidget);
  });

  testWidgets('an available rider is green; on delivery is the accent', (tester) async {
    await _screen(tester);
    MapPin pin(String id) =>
        tester.widget<MapPin>(find.descendant(of: find.byKey(Key('rider-marker-$id')), matching: find.byType(MapPin)));
    expect(pin(deepak).color, AppColors.light.green);
    expect(pin('33333333-3333-4333-8333-333333333304').color, AppColors.light.accent);
  });

  testWidgets('lanes show the counts and open the list for that status', (tester) async {
    final h = await _screen(tester);
    expect(find.descendant(of: find.byKey(const Key('lane-kitchen')), matching: find.text('3')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('lane-on_the_way')), matching: find.text('4')), findsOneWidget);
    await tester.tap(find.byKey(const Key('lane-kitchen')));
    await _settle(tester);
    expect(h.paths, ['/orders?status=kitchen']);
  });

  testWidgets('Unassigned lists the order with an Assign button that opens the rider picker', (tester) async {
    final h = await _screen(tester);
    await _section(tester, 'unassigned');
    expect(find.text('AB12CD34'), findsWidgets);
    await tester.tap(find.byKey(const Key('assign-ab12cd34-0000-4000-8000-000000000001')));
    await _settle(tester);
    expect(h.orders.riderCalls, ['ab12cd34-0000-4000-8000-000000000001']);
    expect(find.text('Assign a rider'), findsOneWidget);
    await tester.tap(find.byKey(const Key('rider-$deepak')));
    await _settle(tester);
    final a = h.orders.actCalls.single.action as Assign;
    expect(a.riderId, deepak);
    expect(h.live.calls.length, greaterThanOrEqualTo(2), reason: 'the board refreshes after the change');
  });

  testWidgets('Delayed shows each delay in words with the estimated times', (tester) async {
    await _screen(tester);
    await _section(tester, 'delayed');
    expect(find.text('Late 9 min'), findsOneWidget);
    expect(find.text('Waiting for pickup 4 min'), findsOneWidget);
    expect(find.text('No rider 6 min'), findsOneWidget);
    expect(find.textContaining('Arrives about'), findsWidgets);
  });

  testWidgets('Alerts reads each signal as a sentence', (tester) async {
    await _screen(tester, size: const Size(1280, 1000));
    await _section(tester, 'alerts');
    expect(find.text("Ravi hasn't sent a location for 9 min during a delivery"), findsOneWidget);
    expect(find.text('Delivery failed: EF56AB78'), findsOneWidget);
    expect(find.text('CD34EF56 is running 9 min late'), findsOneWidget);
    expect(find.text('AB12CD34 has had no rider for 6 min'), findsOneWidget);
    expect(find.text('Spice Hub is 3 min behind on AB12CD34'), findsOneWidget);
  });

  testWidgets('changing the zone asks for that zone', (tester) async {
    final h = await _screen(tester);
    expect(h.live.calls.first, isNull);
    final container = ProviderScope.containerOf(tester.element(find.byType(LiveScreen)));
    container.read(zoneFilterProvider.notifier).set('z1');
    await _settle(tester);
    expect(h.live.calls.last, 'z1');
  });

  testWidgets('a manual advance from Live needs a reason', (tester) async {
    final h = await _screen(tester);
    await _section(tester, 'delayed');
    await tester.tap(find.byKey(const Key('intervene-cd34ef56-0000-4000-8000-000000000002')));
    await _settle(tester);
    await tester.tap(find.text('Mark Delivered'));
    await _settle(tester);
    expect(tester.widget<FilledButton>(find.byKey(const Key('reason-submit'))).onPressed, isNull);
    await tester.tap(find.text('Customer confirmed delivery'));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await _settle(tester);
    final a = h.orders.actCalls.single.action as Advance;
    expect(a.expected, OrderStatus.onTheWay);
    expect(a.reason, 'Customer confirmed delivery');
  });

  testWidgets('polls every 10 s while shown', (tester) async {
    final h = await _screen(tester);
    final n = h.live.calls.length;
    await tester.pump(const Duration(seconds: 10));
    await tester.pump();
    expect(h.live.calls.length, n + 1);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 30));
    expect(h.live.calls.length, n + 1);
  });

  testWidgets('on a tablet the panel sits beside the map', (tester) async {
    await _screen(tester, size: const Size(1280, 860));
    expect(find.byKey(const Key('live-side-panel')), findsOneWidget);
    expect(find.byKey(const Key('lane-kitchen')), findsOneWidget);
  });

  test('a push can open Live on one order', () {
    expect(inAppPathFrom(null, {'appPath': '/live?focus=cd34ef56-0000-4000-8000-000000000002'}),
        '/live?focus=cd34ef56-0000-4000-8000-000000000002');
    expect(inAppPathFrom(null, {'appPath': '/live?focus=<script>'}), '/live');
  });

  testWidgets('Unassigned lists only orders past the grace period, and says so', (tester) async {
    await _screen(tester);
    await _section(tester, 'unassigned');
    expect(find.text('Waiting more than 5 min for a rider'), findsOneWidget);
    await _screen(tester, snapshot: LiveSnapshot.fromJson({...apiFixture('live'), 'unassigned': <String>[]}));
    await _section(tester, 'unassigned');
    expect(find.text('No order has waited more than 5 min for a rider.'), findsOneWidget);
  });
}
