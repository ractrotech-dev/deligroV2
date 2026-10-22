// Performance: targets as rings, times and rates ("—" when there is nothing to
// divide), hours online, ratings, the month-by-month chart and table, and the
// More row that opens it. No network: the insights repository is a fake.
import 'package:deligro_rider/core/duration_text.dart';
import 'package:deligro_rider/data/insights_repository.dart';
import 'package:deligro_rider/features/more/more_screen.dart';
import 'package:deligro_rider/features/performance/performance_screen.dart';
import 'package:deligro_rider/models/dashboard.dart';
import 'package:deligro_rider/models/insights.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/insights.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

Map<String, dynamic> _month(
  int ago, {
  int delivered = 40,
  double? earnings,
  double? rate = 88,
  double? avg = 35,
}) {
  final m = 10 - ago; // 2026-10 back to 2025-11
  final year = m >= 1 ? 2026 : 2025;
  final mo = m >= 1 ? m : m + 12;
  return {
    'month': '$year-${mo.toString().padLeft(2, '0')}',
    'delivered': delivered,
    'failed': 2,
    'cancelled': 3,
    'acceptanceRate': rate,
    'avgDeliverMin': avg,
    'earnings': earnings,
    'onlineHours': 100.5,
  };
}

Map<String, dynamic> _json({
  Map<String, dynamic>? overrides,
  bool earnings = false,
}) => {
  'daily': {'target': 12, 'done': 5},
  'weekly': {'target': 60, 'done': 38},
  'avgAcceptToDeliverMin': 37,
  'avgPickupToDeliverMin': 24,
  'acceptanceRate': 86.5,
  'failedRate': 4,
  'onlineHoursThisWeek': 31.5,
  'rating': {
    'average': 4.6,
    'count': 128,
    'recent': [
      {'rating': 5, 'comment': 'Quick and polite', 'at': '2026-10-21T04:30:00.000Z'},
      {'rating': 3, 'comment': null, 'at': '2026-10-20T04:30:00.000Z'},
    ],
  },
  'months': [
    for (var i = 0; i < 12; i++)
      _month(i, delivered: 10 + i, earnings: earnings ? 2500.0 + i : null),
  ],
  ...?overrides,
};

class _Fake implements InsightsRepository {
  _Fake(this.json);

  Map<String, dynamic> json;
  Object? error;

  @override
  Future<RiderPerformance> performance() async {
    final e = error;
    if (e != null) throw e;
    return RiderPerformance.fromJson(json);
  }

  @override
  Future<RiderDashboard> dashboard() async => const RiderDashboard();

  @override
  Future<HistoryPage> history({
    String? from,
    String? to,
    String? outcome,
    String? cursor,
  }) async => const HistoryPage(items: []);

  @override
  Future<HistoryDetail> historyDetail(String orderId) async =>
      throw UnimplementedError();
}

RiderMe _me({Map<String, bool> features = const {}}) => RiderMe(
  id: 'rider-1',
  name: 'Ravi Kumar',
  phone: '+919876543210',
  riderCode: 'DR-0042',
  availability: RiderAvailabilityDto.offline,
  phase: 'offline',
  features: features,
);

Future<void> _settle(WidgetTester tester, {int rounds = 6}) async {
  for (var i = 0; i < rounds; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump(const Duration(milliseconds: 60));
  }
}

Future<void> _pump(
  WidgetTester tester, {
  required _Fake repo,
  RiderMe? me,
  String start = performancePath,
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
}) async {
  tester.view.physicalSize = const Size(360 * 3, 3200 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final router = GoRouter(initialLocation: start, routes: [moreRoute]);
  final container = ProviderContainer(
    overrides: [
      insightsRepoProvider.overrideWithValue(repo),
      meProvider.overrideWith((_) async => me ?? _me()),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: buildTheme(brightness),
        routerConfig: router,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
      ),
    ),
  );
  await _settle(tester);
}

Finder _in(String key, Finder what) =>
    find.descendant(of: find.byKey(Key(key)), matching: what);

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  test('text helpers', () {
    expect(minutesText(37), '37 min');
    expect(minutesText(95), '1 h 35 min');
    expect(minutesText(120), '2 h');
    expect(minutesText(null), '—');
    expect(percentText(86.5), '86.5%');
    expect(percentText(25), '25%');
    expect(percentText(0), '0%');
    expect(percentText(null), '—');
    expect(hoursText(31.5), '31.5 h');
    expect(hoursText(8), '8 h');
  });

  group('the figures', () {
    testWidgets('targets, times, rates and hours', (tester) async {
      await _pump(tester, repo: _Fake(_json()));
      expect(_in('ring-daily', find.text('5')), findsOneWidget);
      expect(_in('ring-daily', find.text('of 12')), findsOneWidget);
      expect(_in('ring-weekly', find.text('38')), findsOneWidget);
      expect(_in('ring-weekly', find.text('of 60')), findsOneWidget);
      expect(_in('stat-accept-deliver', find.text('37 min')), findsOneWidget);
      expect(_in('stat-pickup-deliver', find.text('24 min')), findsOneWidget);
      expect(_in('stat-acceptance', find.text('86.5%')), findsOneWidget);
      expect(_in('stat-failed', find.text('4%')), findsOneWidget);
      expect(_in('stat-online', find.text('31.5 h')), findsOneWidget);
    });

    testWidgets('rates with nothing to divide show a dash, never 0% or 100%', (
      tester,
    ) async {
      await _pump(
        tester,
        repo: _Fake(
          _json(
            overrides: {
              'avgAcceptToDeliverMin': null,
              'avgPickupToDeliverMin': null,
              'acceptanceRate': null,
              'failedRate': null,
              'daily': {'target': 0, 'done': 0},
              'weekly': {'target': 0, 'done': 0},
              'onlineHoursThisWeek': 0,
              'rating': {'average': null, 'count': 0, 'recent': []},
              'months': [
                for (var i = 0; i < 12; i++)
                  _month(i, delivered: 0, rate: null, avg: null),
              ],
            },
          ),
        ),
      );
      for (final k in [
        'stat-accept-deliver',
        'stat-pickup-deliver',
        'stat-acceptance',
        'stat-failed',
      ]) {
        expect(_in(k, find.text('—')), findsOneWidget, reason: k);
      }
      expect(find.textContaining('%'), findsNothing);
      expect(_in('ring-daily', find.text('No target')), findsOneWidget);
      expect(_in('ring-weekly', find.text('No target')), findsOneWidget);
      expect(_in('stat-online', find.text('0 h')), findsOneWidget);
      expect(find.textContaining('No ratings yet'), findsOneWidget);
      expect(find.textContaining('NaN'), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  group('ratings', () {
    testWidgets('average, count and recent comments without names', (
      tester,
    ) async {
      await _pump(tester, repo: _Fake(_json()));
      expect(_in('rating-card', find.text('4.6')), findsOneWidget);
      expect(_in('rating-card', find.text('128 ratings')), findsOneWidget);
      expect(_in('rating-card', find.text('Quick and polite')), findsOneWidget);
      expect(_in('rating-card', find.byIcon(Icons.star_rounded)), findsWidgets);
    });
  });

  group('the monthly report', () {
    testWidgets('the chart draws one bar for each of the 12 months, oldest first', (
      tester,
    ) async {
      await _pump(tester, repo: _Fake(_json()));
      final chart = tester.widget<BarChart>(find.byType(BarChart));
      final groups = chart.data.barGroups;
      expect(groups, hasLength(12));
      // The server sends newest first (delivered 10 + i); the chart reads
      // oldest to newest, so the first bar is the oldest month (21).
      expect(groups.first.barRods.single.toY, 21);
      expect(groups.last.barRods.single.toY, 10);
    });

    testWidgets('the table has a row per month, newest first', (tester) async {
      await _pump(tester, repo: _Fake(_json()));
      final table = tester.widget<DataTable>(find.byType(DataTable));
      expect(table.rows, hasLength(12));
      expect(find.text('Oct 2026'), findsOneWidget);
      expect(find.text('Nov 2025'), findsOneWidget);
      expect(find.text('Earned'), findsNothing);
    });

    testWidgets('earnings show only when the ledger sent them', (tester) async {
      await _pump(tester, repo: _Fake(_json(earnings: true)));
      expect(find.text('Earned'), findsOneWidget);
      expect(find.text('₹2,500'), findsOneWidget);
    });

    testWidgets('earnings switch off hides the column even if sent', (
      tester,
    ) async {
      await _pump(
        tester,
        repo: _Fake(_json(earnings: true)),
        me: _me(features: const {'driver.earnings': false}),
      );
      expect(find.text('Earned'), findsNothing);
      expect(find.textContaining('₹'), findsNothing);
    });
  });

  group('around it', () {
    testWidgets('More has a Performance row that opens the screen', (
      tester,
    ) async {
      await _pump(tester, repo: _Fake(_json()), start: '/more');
      expect(find.byKey(const Key('row-performance')), findsOneWidget);
      await tester.tap(find.byKey(const Key('row-performance')));
      await _settle(tester);
      expect(find.text('Customer ratings'), findsOneWidget);
    });

    testWidgets('a failed load has a retry', (tester) async {
      final repo = _Fake(_json())..error = Exception('down');
      await _pump(tester, repo: repo);
      expect(find.text('Try again'), findsOneWidget);
      repo.error = null;
      await tester.tap(find.text('Try again'));
      await _settle(tester);
      expect(find.byKey(const Key('targets-card')), findsOneWidget);
    });
  });

  group('look', () {
    for (final dark in [false, true]) {
      for (final scale in [1.0, 1.3]) {
        testWidgets('builds clean in ${dark ? 'dark' : 'light'} at ${scale}x', (
          tester,
        ) async {
          await _pump(
            tester,
            repo: _Fake(_json(earnings: true)),
            brightness: dark ? Brightness.dark : Brightness.light,
            textScale: scale,
          );
          expect(tester.takeException(), isNull);
          expect(find.byType(BarChart), findsOneWidget);
        });
      }
    }
  });

  group('model', () {
    test('a target with nothing to do never divides by zero', () {
      const t = TargetProgress(target: 0, done: 4);
      expect(t.fraction, 0);
      expect(t.hasTarget, isFalse);
      expect(const TargetProgress(target: 4, done: 9).fraction, 1);
    });

    test('a missing block is an empty one', () {
      final p = RiderPerformance.fromJson(const {});
      expect(p.months, isEmpty);
      expect(p.acceptanceRate, isNull);
      expect(p.rating.count, 0);
    });
  });
}
