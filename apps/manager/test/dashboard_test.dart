import 'package:deligro_manager/data/manager_repository.dart';
import 'package:deligro_manager/features/home/dashboard_grid.dart';
import 'package:deligro_manager/models/dashboard.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/state/dashboard.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/widgets/zone_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'helpers.dart';

class _MockRepo extends Mock implements ManagerRepository {}

const _labels = [
  "Today's Total Sales",
  'Total Sales',
  "Today's Orders",
  'Total Orders',
  'Pending Orders',
  'Completed Orders',
  'Cancelled Orders',
  'Active Vendors',
  'Online Vendors',
  'Active Riders',
  'Online Riders',
  'Riders Currently on Delivery',
  'Total Delivery Fees',
  'Total Platform Commission',
  'Vendor Payments Due',
  'Rider Payments Due',
  'Pending Marketing Requests',
  'Pending Support Tickets',
];

Map<String, dynamic> _payload({bool finance = true, List<String> unavailable = const []}) {
  final order = [
    'todaysTotalSales', 'totalSales', 'todaysOrders', 'totalOrders', 'pendingOrders', 'completedOrders',
    'cancelledOrders', 'activeVendors', 'onlineVendors', 'activeRiders', 'onlineRiders', 'ridersOnDelivery',
    if (finance) ...['totalDeliveryFees', 'totalPlatformCommission', 'vendorPaymentsDue', 'riderPaymentsDue'],
    'pendingMarketingRequests', 'pendingSupportTickets',
  ];
  return {
    'today': '2026-10-21',
    'generatedAt': '2026-10-21T09:30:00.000Z',
    'zone': null,
    'order': order,
    'figures': {for (final k in order) k: unavailable.contains(k) ? null : (k == 'totalSales' ? 12340 : 7)},
    'unavailable': unavailable,
  };
}

Future<void> _grid(WidgetTester tester, DashboardData data, {double width = 390, void Function(String)? onOpen}) async {
  tester.view.physicalSize = Size(width, 2400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(await themed(Scaffold(
    body: SingleChildScrollView(child: DashboardGrid(data: data, onOpen: onOpen ?? (_) {})),
  )));
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('the eighteen figures, in the document\'s words and order', (tester) async {
    await _grid(tester, DashboardData.fromJson(_payload()));
    double y(String label) => tester.getTopLeft(find.text(label)).dy;
    double x(String label) => tester.getTopLeft(find.text(label)).dx;
    for (final l in _labels) {
      expect(find.text(l), findsOneWidget, reason: l);
    }
    for (var i = 1; i < _labels.length; i++) {
      final before = _labels[i - 1], now = _labels[i];
      final inOrder = y(now) > y(before) || (y(now) == y(before) && x(now) > x(before));
      expect(inOrder, isTrue, reason: '$before then $now');
    }
  });

  testWidgets('without the finance permission the four money figures are not drawn at all', (tester) async {
    await _grid(tester, DashboardData.fromJson(_payload(finance: false)));
    expect(find.byType(FigureTile), findsNWidgets(14));
    for (final l in ['Total Delivery Fees', 'Total Platform Commission', 'Vendor Payments Due', 'Rider Payments Due']) {
      expect(find.text(l), findsNothing);
    }
  });

  testWidgets('a figure the platform cannot count yet says so', (tester) async {
    await _grid(tester, DashboardData.fromJson(_payload(unavailable: ['pendingSupportTickets'])));
    final tile = find.ancestor(of: find.text('Pending Support Tickets'), matching: find.byType(FigureTile));
    expect(find.descendant(of: tile, matching: find.text('—')), findsOneWidget);
    expect(find.descendant(of: tile, matching: find.text('Arrives with support tickets')), findsOneWidget);
  });

  testWidgets('money is rupees in Indian grouping', (tester) async {
    await _grid(tester, DashboardData.fromJson(_payload()));
    expect(find.text('₹12,340'), findsOneWidget);
  });

  testWidgets('a tile opens the list behind it', (tester) async {
    final opened = <String>[];
    await _grid(tester, DashboardData.fromJson(_payload()), onOpen: opened.add);
    await tester.tap(find.text('Pending Orders'));
    await tester.tap(find.text('Online Riders'));
    expect(opened, ['/orders?status=pending', '/more/riders?filter=online']);
  });

  testWidgets('two columns on a phone, four on a tablet', (tester) async {
    await _grid(tester, DashboardData.fromJson(_payload()));
    double y(String l) => tester.getTopLeft(find.text(l)).dy;
    expect(y('Total Sales'), y("Today's Total Sales"));
    expect(y("Today's Orders") > y('Total Sales'), isTrue);

    await _grid(tester, DashboardData.fromJson(_payload()), width: 900);
    expect(y('Total Orders'), y("Today's Total Sales"));
    expect(y('Pending Orders') > y('Total Orders'), isTrue);
  });

  test('picking a zone fetches that zone\'s figures', () async {
    final repo = _MockRepo();
    final asked = <String?>[];
    when(() => repo.dashboard(zoneId: any(named: 'zoneId'))).thenAnswer((inv) async {
      asked.add(inv.namedArguments[#zoneId] as String?);
      return DashboardData.fromJson(_payload());
    });
    final zone = NotifierProvider<_ZoneNotifier, Zone?>(_ZoneNotifier.new);
    final container = ProviderContainer(overrides: [
      managerRepoProvider.overrideWithValue(repo),
      signedInProvider.overrideWithValue(true),
      activeZoneProvider.overrideWith((ref) => ref.watch(zone)),
    ]);
    addTearDown(container.dispose);
    final sub = container.listen(dashboardProvider, (_, _) {});
    addTearDown(sub.close);
    await container.read(dashboardProvider.future);
    container.read(zone.notifier).set(const Zone(id: 'z2', name: 'Station Road', slug: 'station-road', isDefault: false, cityName: 'Bemetara'));
    await container.read(dashboardProvider.future);
    expect(asked, [null, 'z2']);
  });

  test('a failed load is an error, not a dashboard of zeros', () async {
    final repo = _MockRepo();
    when(() => repo.dashboard(zoneId: any(named: 'zoneId'))).thenThrow(Exception('offline'));
    final container = ProviderContainer(overrides: [
      managerRepoProvider.overrideWithValue(repo),
      signedInProvider.overrideWithValue(true),
      activeZoneProvider.overrideWithValue(null),
    ]);
    addTearDown(container.dispose);
    final sub = container.listen(dashboardProvider, (_, _) {});
    addTearDown(sub.close);
    await expectLater(container.read(dashboardProvider.future), throwsA(isA<Exception>()));
  });
}

class _ZoneNotifier extends Notifier<Zone?> {
  @override
  Zone? build() => null;
  void set(Zone? z) => state = z;
}
