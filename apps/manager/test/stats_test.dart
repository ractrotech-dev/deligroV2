import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/data/manager_repository.dart';
import 'package:deligro_manager/features/stats/stats_screen.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/models/stats.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/state/stats.dart';
import 'package:deligro_manager/widgets/zone_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'auth_test.dart' show meJson;
import 'helpers.dart';
import 'stats_fixture.dart';

class _MockRepo extends Mock implements ManagerRepository {}

class _FixedMe extends ManagerMeNotifier {
  _FixedMe(this.me);
  final ManagerMe me;
  @override
  Future<ManagerMe?> build() async => me;
}

ManagerMe _me({bool reports = true}) =>
    ManagerMe.fromJson({...meJson, 'permissions': {'manager.reports.view': reports}});

Future<void> _screen(WidgetTester tester,
    {Map<String, dynamic>? data, Object? error, bool reports = true, double width = 390}) async {
  tester.view.physicalSize = Size(width, 6000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final repo = _MockRepo();
  if (error != null) {
    when(() => repo.stats(any())).thenThrow(error);
  } else {
    when(() => repo.stats(any())).thenAnswer((_) async => StatsData.fromJson(data ?? statsJson()));
  }
  await tester.pumpWidget(await themed(const StatsScreen(), overrides: [
    managerRepoProvider.overrideWithValue(repo),
    managerMeProvider.overrideWith(() => _FixedMe(_me(reports: reports))),
    activeZoneProvider.overrideWithValue(null),
  ]));
  await tester.pumpAndSettle();
}

void main() {
  setUpAll(() => registerFallbackValue(const StatsQuery(period: Period.month)));

  testWidgets('every §2 section, in order', (tester) async {
    await _screen(tester);
    const sections = [
      'Day-by-day sales',
      'Growth',
      'Orders',
      'Completed vs cancelled',
      'Average order value',
      'Peak ordering hours',
      'Best-performing vendors',
      'Best-performing categories',
      'By city and zone',
    ];
    double y(String s) => tester.getTopLeft(find.text(s).first).dy;
    for (final s in sections) {
      expect(find.text(s), findsWidgets, reason: s);
    }
    for (var i = 1; i < sections.length; i++) {
      expect(y(sections[i]) > y(sections[i - 1]), isTrue, reason: '${sections[i - 1]} then ${sections[i]}');
    }
  });

  testWidgets('growth from nothing reads "New"; a fall points down', (tester) async {
    await _screen(tester);
    expect(find.text('New'), findsWidgets);
    expect(find.byKey(const Key('growth-sales-down')), findsOneWidget);
    expect(find.text('12.5%'), findsOneWidget);
  });

  testWidgets('the peak grid has a cell for every hour of the week and names the busiest', (tester) async {
    await _screen(tester);
    expect(find.byKey(const ValueKey('peak-cell')), findsNWidgets(168));
    expect(find.text('Busiest: 8 PM'), findsOneWidget);
  });

  testWidgets('vendors are ranked, named and rated', (tester) async {
    await _screen(tester);
    expect(find.text('Spice Hub'), findsOneWidget);
    expect(find.text('Tandoor, Bemetara'), findsOneWidget);
    expect(find.text('4.4'), findsOneWidget);
    expect(find.byIcon(Icons.star_rounded), findsOneWidget);
    expect(find.text('₹3,200'), findsWidgets);
  });

  testWidgets('the report can be downloaded as CSV, Excel or PDF', (tester) async {
    await _screen(tester);
    await tester.tap(find.byKey(const Key('stats-download')));
    await tester.pumpAndSettle();
    expect(find.text('CSV'), findsOneWidget);
    expect(find.text('Excel'), findsOneWidget);
    expect(find.text('PDF'), findsOneWidget);
  });

  testWidgets('a period with no orders says so instead of drawing zeros', (tester) async {
    await _screen(tester, data: statsJson(empty: true));
    expect(find.text('No orders in this period.'), findsOneWidget);
    expect(find.text('Best-performing vendors'), findsNothing);
  });

  testWidgets('a range longer than a year is explained in words', (tester) async {
    await _screen(tester, error: ApiException(400, 'range_too_long'));
    expect(find.text('Pick a range of a year or less.'), findsOneWidget);
  });

  testWidgets('without the reports permission the screen says so', (tester) async {
    await _screen(tester, reports: false);
    expect(find.text("You don't have access to statistics. Ask an admin."), findsOneWidget);
  });

  test('a custom range is asked for as from and to dates', () async {
    final repo = _MockRepo();
    final asked = <StatsQuery>[];
    when(() => repo.stats(any())).thenAnswer((inv) async {
      asked.add(inv.positionalArguments.first as StatsQuery);
      return StatsData.fromJson(statsJson());
    });
    final container = ProviderContainer(overrides: [
      managerRepoProvider.overrideWithValue(repo),
      activeZoneProvider.overrideWithValue(null),
    ]);
    addTearDown(container.dispose);
    final sub = container.listen(statsProvider, (_, _) {});
    addTearDown(sub.close);
    await container.read(statsProvider.future);
    container.read(statsQueryProvider.notifier).setCustom(DateTimeRange(start: DateTime(2026, 10, 1), end: DateTime(2026, 10, 5)));
    await container.read(statsProvider.future);
    expect(asked.last.toQuery(), {'granularity': 'custom', 'from': '2026-10-01', 'to': '2026-10-05'});
    expect(asked.first.toQuery(), {'granularity': 'month'});
  });

  testWidgets('a period with no orders after one with orders shows the fall, not just "no orders"', (tester) async {
    final j = statsJson(empty: true);
    j['growth'] = {
      'sales': {'current': 0, 'previous': 6000, 'change': -6000, 'pct': -100.0},
      'orders': {'current': 0, 'previous': 24, 'change': -24, 'pct': -100.0},
    };
    await _screen(tester, data: j);
    expect(find.text('No orders in this period.'), findsOneWidget);
    expect(find.byKey(const Key('growth-sales-down')), findsOneWidget);
    expect(find.byKey(const Key('growth-orders-down')), findsOneWidget);
    expect(find.text('100.0%'), findsNWidgets(2));
  });

  testWidgets('each city is subtotalled above its zones', (tester) async {
    await _screen(tester);
    expect(find.byKey(const Key('city-Bemetara')), findsOneWidget);
    expect(tester.getTopLeft(find.byKey(const Key('city-Bemetara'))).dy,
        lessThan(tester.getTopLeft(find.text('Bemetara · Central')).dy));
  });

  testWidgets('on a tablet the sections sit in two columns', (tester) async {
    await _screen(tester, width: 1000);
    final left = tester.getTopLeft(find.text('Day-by-day sales')).dx;
    final right = tester.getTopLeft(find.text('Growth')).dx;
    expect(right - left, greaterThan(300));
  });

  testWidgets('on a phone they are one column', (tester) async {
    await _screen(tester);
    expect(tester.getTopLeft(find.text('Growth')).dx, tester.getTopLeft(find.text('Day-by-day sales')).dx);
  });

  testWidgets('opened for one vendor, it asks for that vendor and names it', (tester) async {
    tester.view.physicalSize = const Size(390, 6000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final repo = _MockRepo();
    final asked = <StatsQuery>[];
    when(() => repo.stats(any())).thenAnswer((inv) async {
      asked.add(inv.positionalArguments.first as StatsQuery);
      return StatsData.fromJson(statsJson());
    });
    await tester.pumpWidget(await themed(const StatsScreen(vendorId: 'v-1', vendorName: 'Spice Hub'), overrides: [
      managerRepoProvider.overrideWithValue(repo),
      managerMeProvider.overrideWith(() => _FixedMe(ManagerMe.fromJson({
            ...meJson,
            'permissions': {'manager.reports.view': true, 'manager.vendors.view': true},
          }))),
      activeZoneProvider.overrideWithValue(null),
    ]));
    await tester.pumpAndSettle();
    expect(asked, isNotEmpty);
    expect(asked.every((q) => q.toQuery()['vendor'] == 'v-1'), isTrue);
    expect(find.text('Statistics · Spice Hub'), findsOneWidget);
  });
}
