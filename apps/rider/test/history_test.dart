// History: filters build the right query, an empty state per filter, infinite
// scroll by cursor, rows (earning only when real), the detail with its proof,
// reason and timeline, the tab's switch, light/dark/1.3x. No network: the
// insights repository is a fake.
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/data/insights_repository.dart';
import 'package:deligro_rider/features/history/history_filters.dart';
import 'package:deligro_rider/features/history/history_screen.dart';
import 'package:deligro_rider/features/shell/rider_shell.dart';
import 'package:deligro_rider/state/history.dart';
import 'package:deligro_rider/models/dashboard.dart';
import 'package:deligro_rider/models/insights.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/clock.dart';
import 'package:deligro_rider/state/insights.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

// Thursday 22 Oct 2026, 09:00 IST.
final _now = DateTime.utc(2026, 10, 22, 3, 30);

Map<String, dynamic> _item(
  int i, {
  String outcome = 'delivered',
  double? earning,
  String? reason,
  String? cancelledBy,
  String? proof,
  double? km = 3.4,
  String? dropArea = 'Sector 14',
}) => {
  'orderId': 'order-$i',
  'code': '#A${1000 + i}',
  'shop': 'Shop $i',
  'dropArea': dropArea,
  'outcome': outcome,
  // 22 Oct 2026, 08:10 -> 08:42 IST.
  'acceptedAt': '2026-10-22T02:40:00.000Z',
  'pickedUpAt': '2026-10-22T02:50:00.000Z',
  'deliveredAt': outcome == 'delivered' ? '2026-10-22T03:12:00.000Z' : null,
  'endedAt': '2026-10-22T03:12:00.000Z',
  'distanceKm': km,
  'earning': earning,
  'reason': reason,
  'cancelledBy': cancelledBy,
  'proof': outcome == 'delivered' ? (proof ?? 'code') : null,
  'itemCount': 3,
  'orderValue': 251,
};

typedef _Query = ({String? from, String? to, String? outcome, String? cursor});

class _Fake implements InsightsRepository {
  _Fake({this.pages});

  /// Answers a history call; default: one page of three delivered rows.
  HistoryPage Function(_Query q)? pages;
  final calls = <_Query>[];
  Object? historyError;
  Object? detailError;
  Map<String, dynamic>? detailJson;
  int detailCalls = 0;

  @override
  Future<RiderDashboard> dashboard() async => const RiderDashboard();

  @override
  Future<HistoryPage> history({
    String? from,
    String? to,
    String? outcome,
    String? cursor,
  }) async {
    final q = (from: from, to: to, outcome: outcome, cursor: cursor);
    calls.add(q);
    final e = historyError;
    if (e != null) throw e;
    return pages?.call(q) ??
        HistoryPage.fromJson({
          'items': [_item(1), _item(2), _item(3)],
        });
  }

  @override
  Future<HistoryDetail> historyDetail(String orderId) async {
    detailCalls++;
    final e = detailError;
    if (e != null) throw e;
    return HistoryDetail.fromJson(
      detailJson ??
          {
            ..._item(1, earning: 32),
            'timeline': [
              {
                'kind': 'accepted',
                'method': null,
                'reason': null,
                'at': '2026-10-22T02:40:00.000Z',
              },
              {
                'kind': 'picked_up',
                'method': 'code',
                'reason': null,
                'at': '2026-10-22T02:50:00.000Z',
              },
              {
                'kind': 'delivered',
                'method': 'photo',
                'reason': null,
                'at': '2026-10-22T03:12:00.000Z',
              },
            ],
            'proofPhotoUrl': 'https://example.test/signed/proof.jpg?token=abc',
            'items': [
              {'name': 'Paneer roll', 'qty': 2},
              {'name': 'Cola', 'qty': 1},
            ],
          },
    );
  }

  @override
  Future<RiderPerformance> performance() async => const RiderPerformance();
}

RiderMe _me({String id = 'rider-1', Map<String, bool> features = const {}}) =>
    RiderMe(
      id: id,
      name: 'Ravi Kumar',
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

late ProviderContainer lastContainer;

Future<GoRouter> _pump(
  WidgetTester tester, {
  required _Fake repo,
  RiderMe? me,
  RiderMe Function()? meFn,
  String start = '/history',
  bool realShell = false,
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  double height = 1400,
}) async {
  tester.view.physicalSize = Size(360 * 3, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  // The real app's shape: History is a branch of the tab shell, so a dialog
  // sits on the root navigator above the branch's own.
  final router = GoRouter(
    initialLocation: start,
    routes: realShell
        ? [
            StatefulShellRoute.indexedStack(
              builder: (_, _, shell) => RiderShell(shell: shell),
              branches: [
                for (final tab in riderTabs)
                  StatefulShellBranch(routes: [tab.route]),
              ],
            ),
          ]
        : [historyRoute],
  );
  final container = ProviderContainer(
    overrides: [
      insightsRepoProvider.overrideWithValue(repo),
      clockProvider.overrideWithValue(() => _now),
      meProvider.overrideWith((_) async => meFn?.call() ?? me ?? _me()),
    ],
  );
  addTearDown(container.dispose);
  lastContainer = container;
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: buildTheme(brightness),
        routerConfig: router,
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
      ),
    ),
  );
  await _settle(tester);
  return router;
}

Future<void> _tap(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await _settle(tester);
}

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('filters', () {
    test('every range and outcome builds the right query', () {
      const today = '2026-10-22'; // a Thursday
      expect(const HistoryFilter(range: HistoryRange.today).query(today), (
        from: '2026-10-22',
        to: '2026-10-22',
        outcome: null,
      ));
      expect(const HistoryFilter(range: HistoryRange.yesterday).query(today), (
        from: '2026-10-21',
        to: '2026-10-21',
        outcome: null,
      ));
      expect(const HistoryFilter(range: HistoryRange.week).query(today), (
        from: '2026-10-19',
        to: '2026-10-22',
        outcome: null,
      ));
      expect(const HistoryFilter(range: HistoryRange.month).query(today), (
        from: '2026-10-01',
        to: '2026-10-22',
        outcome: null,
      ));
      expect(
        const HistoryFilter(
          range: HistoryRange.custom,
          customFrom: '2026-09-03',
          customTo: '2026-09-09',
          outcome: HistoryOutcome.failed,
        ).query(today),
        (from: '2026-09-03', to: '2026-09-09', outcome: 'failed'),
      );
      // A Monday is its own week's first day; a Sunday reaches back six days.
      expect(
        const HistoryFilter(range: HistoryRange.week).query('2026-10-19').from,
        '2026-10-19',
      );
      expect(
        const HistoryFilter(range: HistoryRange.week).query('2026-10-25').from,
        '2026-10-19',
      );
    });

    testWidgets('opens on this month, all outcomes', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo);
      expect(repo.calls, hasLength(1));
      expect(repo.calls.single.from, '2026-10-01');
      expect(repo.calls.single.to, '2026-10-22');
      expect(repo.calls.single.outcome, isNull);
      expect(repo.calls.single.cursor, isNull);
      expect(
        find.text('Jobs are listed under the day they ended.'),
        findsOneWidget,
      );
    });

    testWidgets('the chips change the query and start over', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('range-today')));
      expect(repo.calls.last.from, '2026-10-22');
      expect(repo.calls.last.to, '2026-10-22');
      await _tap(tester, find.byKey(const Key('range-yesterday')));
      expect(repo.calls.last.from, '2026-10-21');
      await _tap(tester, find.byKey(const Key('range-week')));
      expect(repo.calls.last.from, '2026-10-19');
      await _tap(tester, find.byKey(const Key('outcome-failed')));
      expect(repo.calls.last.outcome, 'failed');
      expect(repo.calls.last.from, '2026-10-19');
      await _tap(tester, find.byKey(const Key('outcome-reassigned')));
      expect(repo.calls.last.outcome, 'reassigned');
      await _tap(tester, find.byKey(const Key('outcome-delivered')));
      expect(repo.calls.last.outcome, 'delivered');
      await _tap(tester, find.byKey(const Key('outcome-cancelled')));
      expect(repo.calls.last.outcome, 'cancelled');
      await _tap(tester, find.byKey(const Key('outcome-all')));
      expect(repo.calls.last.outcome, isNull);
      expect(repo.calls.every((c) => c.cursor == null), isTrue);
    });

    testWidgets('a link pre-filters', (tester) async {
      final repo = _Fake();
      await _pump(
        tester,
        repo: repo,
        start: '/history?range=today&outcome=delivered',
      );
      expect(repo.calls.last.from, '2026-10-22');
      expect(repo.calls.last.to, '2026-10-22');
      expect(repo.calls.last.outcome, 'delivered');
      final today = tester.widget<ChoiceChip>(
        find.byKey(const Key('range-today')),
      );
      expect(today.selected, isTrue);
      final delivered = tester.widget<ChoiceChip>(
        find.byKey(const Key('outcome-delivered')),
      );
      expect(delivered.selected, isTrue);
    });

    testWidgets('a link without an outcome means all', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo, start: '/history?range=week');
      expect(repo.calls.last.from, '2026-10-19');
      expect(repo.calls.last.outcome, isNull);
    });
  });

  group('empty and failing', () {
    testWidgets('an empty state says which filter found nothing', (
      tester,
    ) async {
      final repo = _Fake(pages: (_) => const HistoryPage(items: []));
      await _pump(tester, repo: repo, start: '/history?range=today');
      expect(find.text('No deliveries today'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('outcome-failed')));
      expect(find.text('No failed jobs today'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('range-week')));
      expect(find.text('No failed jobs this week'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('outcome-cancelled')));
      expect(find.text('No cancelled jobs this week'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('outcome-reassigned')));
      expect(find.text('No reassigned jobs this week'), findsOneWidget);
      await _tap(tester, find.byKey(const Key('outcome-delivered')));
      await _tap(tester, find.byKey(const Key('range-month')));
      expect(find.text('No delivered jobs this month'), findsOneWidget);
    });

    testWidgets('a failed load has a retry', (tester) async {
      final repo = _Fake()..historyError = ApiException(500, 'server_error');
      await _pump(tester, repo: repo);
      expect(find.text('Try again'), findsOneWidget);
      repo.historyError = null;
      await _tap(tester, find.text('Try again'));
      expect(find.text('#A1001'), findsOneWidget);
    });
  });

  group('the list', () {
    testWidgets('a row shows code, shop, area, outcome, times and distance', (
      tester,
    ) async {
      await _pump(tester, repo: _Fake());
      final row = find.byKey(const Key('history-row-order-1'));
      expect(
        find.descendant(of: row, matching: find.text('#A1001')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.text('Shop 1 → Sector 14')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.text('Delivered')),
        findsOneWidget,
      );
      // 08:10 - 08:42 IST, 32 minutes.
      expect(
        find.descendant(
          of: row,
          matching: find.text('22 Oct, 8:10 AM – 8:42 AM · 32 min'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.text('3.4 km')),
        findsOneWidget,
      );
    });

    testWidgets('earning shows only when real; never for 0 or null', (
      tester,
    ) async {
      final repo = _Fake(
        pages: (_) => HistoryPage.fromJson({
          'items': [
            _item(1, earning: 32),
            _item(2, earning: 0),
            _item(3, earning: null),
          ],
        }),
      );
      await _pump(tester, repo: repo);
      expect(
        find.descendant(
          of: find.byKey(const Key('history-row-order-1')),
          matching: find.text('₹32'),
        ),
        findsOneWidget,
      );
      expect(find.byKey(const Key('row-earning')), findsOneWidget);
    });

    testWidgets('earnings switch off hides the earning even if sent', (
      tester,
    ) async {
      final repo = _Fake(
        pages: (_) => HistoryPage.fromJson({
          'items': [_item(1, earning: 32)],
        }),
      );
      await _pump(
        tester,
        repo: repo,
        me: _me(features: const {'driver.earnings': false}),
      );
      expect(find.byKey(const Key('row-earning')), findsNothing);
      expect(find.textContaining('₹'), findsNothing);
    });

    testWidgets('failed, cancelled and reassigned rows show why', (
      tester,
    ) async {
      final repo = _Fake(
        pages: (_) => HistoryPage.fromJson({
          'items': [
            _item(1, outcome: 'failed', reason: 'Customer unreachable'),
            _item(
              2,
              outcome: 'cancelled',
              reason: 'Customer cancelled',
              cancelledBy: 'customer',
            ),
            _item(3, outcome: 'reassigned', reason: 'Handed back to dispatch'),
          ],
        }),
      );
      await _pump(tester, repo: repo);
      Finder chip(int i, String label) => find.descendant(
        of: find.byKey(Key('history-row-order-$i')),
        matching: find.text(label),
      );
      expect(chip(1, 'Failed'), findsOneWidget);
      expect(chip(2, 'Cancelled'), findsOneWidget);
      expect(chip(3, 'Reassigned'), findsOneWidget);
      expect(find.text('Customer unreachable'), findsOneWidget);
      expect(find.text('Handed back to dispatch'), findsOneWidget);
    });

    testWidgets(
      'scrolling to the end loads the next page by cursor, no repeats',
      (tester) async {
        final repo = _Fake(
          pages: (q) => switch (q.cursor) {
            null => HistoryPage.fromJson({
              'items': [for (var i = 0; i < 20; i++) _item(i)],
              'nextCursor': 'c1',
            }),
            'c1' => HistoryPage.fromJson({
              'items': [for (var i = 20; i < 25; i++) _item(i)],
              'nextCursor': null,
            }),
            _ => const HistoryPage(items: []),
          },
        );
        await _pump(tester, repo: repo, height: 700);
        expect(repo.calls, hasLength(1));
        expect(find.byKey(const Key('history-row-order-24')), findsNothing);
        await tester.drag(
          find.byKey(const Key('history-list')),
          const Offset(0, -4000),
        );
        await _settle(tester);
        await tester.drag(
          find.byKey(const Key('history-list')),
          const Offset(0, -4000),
        );
        await _settle(tester);
        expect(repo.calls, hasLength(2));
        expect(repo.calls.last.cursor, 'c1');
        expect(find.byKey(const Key('history-row-order-24')), findsOneWidget);
        // The end: no third call, no spinner.
        await tester.drag(
          find.byKey(const Key('history-list')),
          const Offset(0, -4000),
        );
        await _settle(tester);
        expect(repo.calls, hasLength(2));
        expect(find.byType(CircularProgressIndicator), findsNothing);
      },
    );

    testWidgets('a failed next page keeps the rows and offers a retry', (
      tester,
    ) async {
      var fail = true;
      final repo = _Fake(
        pages: (q) {
          if (q.cursor == null) {
            return HistoryPage.fromJson({
              'items': [for (var i = 0; i < 3; i++) _item(i)],
              'nextCursor': 'c1',
            });
          }
          if (fail) throw ApiException(0, 'offline');
          return HistoryPage.fromJson({
            'items': [_item(9)],
          });
        },
      );
      await _pump(tester, repo: repo);
      expect(find.byKey(const Key('history-more-retry')), findsOneWidget);
      expect(find.byKey(const Key('history-row-order-0')), findsOneWidget);
      fail = false;
      await _tap(tester, find.byKey(const Key('history-more-retry')));
      expect(find.byKey(const Key('history-row-order-9')), findsOneWidget);
    });
  });

  group('detail', () {
    testWidgets(
      'a delivered job: times, distance, earning, proof photo, items, timeline',
      (tester) async {
        await _pump(tester, repo: _Fake());
        await _tap(tester, find.byKey(const Key('history-row-order-1')));
        expect(find.text('#A1001'), findsWidgets);
        expect(find.text('22 Oct, 8:10 AM'), findsOneWidget); // accepted
        expect(find.text('22 Oct, 8:20 AM'), findsOneWidget); // picked up
        expect(find.text('22 Oct, 8:42 AM'), findsOneWidget); // delivered
        expect(find.text('32 min'), findsOneWidget);
        expect(find.text('3.4 km'), findsOneWidget);
        expect(find.text('₹32'), findsOneWidget);
        expect(find.text("The customer's code"), findsOneWidget);
        final photo = tester.widget<Image>(
          find.byKey(const Key('proof-photo-image')),
        );
        expect(
          (photo.image as NetworkImage).url,
          'https://example.test/signed/proof.jpg?token=abc',
        );
        expect(find.text('Paneer roll'), findsOneWidget);
        expect(find.text('2×'), findsOneWidget);
        expect(find.text('Accepted'), findsWidgets);
        expect(find.text('Delivered with a photo'), findsOneWidget);
      },
    );

    testWidgets('tapping the photo opens it large', (tester) async {
      await _pump(tester, repo: _Fake());
      await _tap(tester, find.byKey(const Key('history-row-order-1')));
      await _tap(tester, find.byKey(const Key('proof-photo')));
      expect(find.byKey(const Key('proof-photo-large')), findsOneWidget);
      await _tap(tester, find.byKey(const Key('proof-photo-close')));
      expect(find.byKey(const Key('proof-photo-large')), findsNothing);
    });

    testWidgets('proof without a photo: ops approved says so, no photo', (
      tester,
    ) async {
      final repo = _Fake()
        ..detailJson = {
          ..._item(1, proof: 'ops_approved'),
          'timeline': [],
          'proofPhotoUrl': null,
          'items': [],
        };
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('history-row-order-1')));
      expect(find.text('Approved by ops'), findsOneWidget);
      expect(find.byKey(const Key('proof-photo')), findsNothing);
      expect(find.text('₹32'), findsNothing);
    });

    testWidgets('a cancelled job shows the reason and who cancelled', (
      tester,
    ) async {
      final repo = _Fake()
        ..detailJson = {
          ..._item(
            1,
            outcome: 'cancelled',
            reason: 'Customer cancelled the order',
            cancelledBy: 'customer',
          ),
          'timeline': [],
          'proofPhotoUrl': null,
          'items': [],
        };
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('history-row-order-1')));
      expect(find.text('Customer cancelled the order'), findsWidgets);
      expect(find.text('Cancelled by'), findsOneWidget);
      expect(find.text('The customer'), findsOneWidget);
      expect(find.text('Proof'), findsNothing);
      expect(find.text('Delivered'), findsNothing);
    });

    testWidgets('an order that is not theirs says so', (tester) async {
      final repo = _Fake()..detailError = ApiException(404, 'not_found');
      await _pump(tester, repo: repo, start: '/history/order/someone-elses');
      expect(find.text("This delivery isn't in your history"), findsOneWidget);
    });
  });

  group('not delivered', () {
    HistoryPage mixed(_Query q) => HistoryPage.fromJson({
      'items': [
        _item(1),
        _item(2, outcome: 'failed', reason: 'Unreachable'),
        _item(3),
        _item(
          4,
          outcome: 'cancelled',
          reason: 'Cancelled',
          cancelledBy: 'customer',
        ),
        _item(5, outcome: 'reassigned', reason: 'Handed back'),
      ],
    });

    testWidgets(
      'the Cancelled tile link lists every job not delivered, the same count',
      (tester) async {
        final repo = _Fake(pages: mixed);
        await _pump(
          tester,
          repo: repo,
          start: '/history?range=today&outcome=not_delivered',
        );
        // The server only filters by one outcome: it is asked for all of them.
        expect(repo.calls.single.outcome, isNull);
        expect(repo.calls.single.from, '2026-10-22');
        expect(repo.calls.single.to, '2026-10-22');
        expect(find.byKey(const Key('history-row-order-2')), findsOneWidget);
        expect(find.byKey(const Key('history-row-order-4')), findsOneWidget);
        expect(find.byKey(const Key('history-row-order-5')), findsOneWidget);
        expect(find.byKey(const Key('history-row-order-1')), findsNothing);
        expect(find.byKey(const Key('history-row-order-3')), findsNothing);
        // Home's tile counts cancelled 1 + failed 1 + reassigned 1 = 3 rows.
        expect(
          find.byWidgetPredicate(
            (w) => w.key.toString().startsWith("[<'history-row-"),
          ),
          findsNWidgets(3),
        );
        final chip = tester.widget<ChoiceChip>(
          find.byKey(const Key('outcome-not-delivered')),
        );
        expect(chip.selected, isTrue);
      },
    );

    testWidgets('a chip does the same from inside History', (tester) async {
      final repo = _Fake(pages: mixed);
      await _pump(tester, repo: repo);
      await _tap(tester, find.byKey(const Key('outcome-not-delivered')));
      expect(repo.calls.last.outcome, isNull);
      expect(find.byKey(const Key('history-row-order-1')), findsNothing);
      expect(find.byKey(const Key('history-row-order-2')), findsOneWidget);
      await _tap(tester, find.byKey(const Key('outcome-failed')));
      expect(repo.calls.last.outcome, 'failed');
    });

    testWidgets(
      'a day of mostly delivered jobs is read on until the others turn up',
      (tester) async {
        final repo = _Fake(
          pages: (q) => q.cursor == null
              ? HistoryPage.fromJson({
                  'items': [for (var i = 0; i < 20; i++) _item(i)],
                  'nextCursor': 'c1',
                })
              : HistoryPage.fromJson({
                  'items': [
                    _item(50, outcome: 'failed', reason: 'Unreachable'),
                    _item(51, outcome: 'cancelled', reason: 'Cancelled'),
                  ],
                }),
        );
        await _pump(
          tester,
          repo: repo,
          start: '/history?range=week&outcome=not_delivered',
        );
        expect(repo.calls.map((c) => c.cursor), [null, 'c1']);
        expect(find.byKey(const Key('history-row-order-50')), findsOneWidget);
        expect(find.byKey(const Key('history-row-order-51')), findsOneWidget);
        expect(find.byKey(const Key('history-row-order-3')), findsNothing);
      },
    );

    testWidgets('its empty state', (tester) async {
      final repo = _Fake(
        pages: (_) => HistoryPage.fromJson({
          'items': [_item(1), _item(2)],
        }),
      );
      await _pump(
        tester,
        repo: repo,
        start: '/history?range=today&outcome=not_delivered',
      );
      expect(find.text('No undelivered jobs today'), findsOneWidget);
    });
  });

  group('links from Home apply every time', () {
    testWidgets('the same filter link again resets what the rider changed', (
      tester,
    ) async {
      final repo = _Fake();
      final router = await _pump(
        tester,
        repo: repo,
        start: '/history?range=today&outcome=delivered&n=1',
      );
      expect(repo.calls.last.outcome, 'delivered');
      await _tap(tester, find.byKey(const Key('range-week')));
      await _tap(tester, find.byKey(const Key('outcome-failed')));
      expect(repo.calls.last.outcome, 'failed');
      expect(repo.calls.last.from, '2026-10-19');
      // Back on Home, the rider taps the same tile again.
      router.go('/history?range=today&outcome=delivered&n=2');
      await _settle(tester);
      expect(repo.calls.last.outcome, 'delivered');
      expect(repo.calls.last.from, '2026-10-22');
      expect(
        tester
            .widget<ChoiceChip>(find.byKey(const Key('range-today')))
            .selected,
        isTrue,
      );
    });
  });

  group('a failing next page', () {
    testWidgets('asks once, and again only when the rider taps Try again', (
      tester,
    ) async {
      var fail = true;
      final repo = _Fake(
        pages: (q) {
          if (q.cursor == null) {
            return HistoryPage.fromJson({
              'items': [for (var i = 0; i < 20; i++) _item(i)],
              'nextCursor': 'c1',
            });
          }
          if (fail) throw ApiException(0, 'offline');
          return HistoryPage.fromJson({
            'items': [_item(90)],
          });
        },
      );
      await _pump(tester, repo: repo, height: 700);
      await tester.drag(
        find.byKey(const Key('history-list')),
        const Offset(0, -6000),
      );
      await _settle(tester, rounds: 3);
      expect(repo.calls, hasLength(2));
      // Frames and scrolls go by: still the one failed request.
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      await tester.drag(
        find.byKey(const Key('history-list')),
        const Offset(0, -300),
      );
      await _settle(tester, rounds: 3);
      expect(repo.calls, hasLength(2));
      expect(find.byKey(const Key('history-more-retry')), findsOneWidget);
      fail = false;
      await _tap(tester, find.byKey(const Key('history-more-retry')));
      expect(repo.calls, hasLength(3));
      expect(find.byKey(const Key('history-row-order-90')), findsOneWidget);
    });
  });

  group('the photo viewer in the real shell', () {
    testWidgets('Close closes the photo and leaves the delivery page open', (
      tester,
    ) async {
      final repo = _Fake();
      await _pump(tester, repo: repo, realShell: true);
      await _tap(tester, find.byKey(const Key('history-row-order-1')));
      expect(find.byKey(const Key('proof-photo')), findsOneWidget);
      await _tap(tester, find.byKey(const Key('proof-photo')));
      expect(find.byKey(const Key('proof-photo-large')), findsOneWidget);
      await _tap(tester, find.byKey(const Key('proof-photo-close')));
      expect(find.byKey(const Key('proof-photo-large')), findsNothing);
      // Still on the delivery, not thrown back to the list.
      expect(find.byKey(const Key('proof-photo')), findsOneWidget);
      expect(find.text('Times'), findsOneWidget);
    });
  });

  group('an outcome the app does not know', () {
    testWidgets('shows Other, never Cancelled', (tester) async {
      final repo = _Fake(
        pages: (_) => HistoryPage.fromJson({
          'items': [_item(1, outcome: 'teleported')],
        }),
      );
      await _pump(tester, repo: repo);
      final row = find.byKey(const Key('history-row-order-1'));
      expect(
        find.descendant(of: row, matching: find.text('Other')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.text('Cancelled')),
        findsNothing,
      );
    });

    test('is parsed as other', () {
      expect(
        HistoryItem.fromJson(_item(1, outcome: 'teleported')).outcome,
        HistoryOutcome.other,
      );
      expect(HistoryOutcome.tryParse('teleported'), isNull);
      expect(HistoryOutcome.tryParse('other'), isNull);
    });
  });

  group('another rider on the same phone', () {
    testWidgets('the last riders list is dropped and theirs loads', (
      tester,
    ) async {
      var who = 'rider-a';
      final repo = _Fake(
        pages: (_) => HistoryPage.fromJson({
          'items': [
            {
              ..._item(who == 'rider-a' ? 1 : 2),
              'shop': who == 'rider-a' ? 'Riders A shop' : 'Riders B shop',
            },
          ],
        }),
      );
      await _pump(
        tester,
        repo: repo,
        meFn: () => _me(id: who),
      );
      expect(find.text('Riders A shop → Sector 14'), findsOneWidget);
      who = 'rider-b';
      lastContainer.invalidate(meProvider);
      await _settle(tester);
      expect(find.text('Riders A shop → Sector 14'), findsNothing);
      expect(find.text('Riders B shop → Sector 14'), findsOneWidget);
      expect(
        lastContainer.read(historyListProvider).items.single.orderId,
        'order-2',
      );
    });
  });

  group('the tab switch', () {
    test('History is the fourth tab, shown unless driver.history is off', () {
      expect(riderTabs.map((t) => t.id), [
        'home',
        'jobs',
        'earnings',
        'history',
        'more',
      ]);
      final tab = riderTabs.firstWhere((t) => t.id == 'history');
      expect(tab.shownFor(_me()), isTrue);
      expect(tab.shownFor(null), isTrue);
      expect(
        tab.shownFor(_me(features: const {'driver.history': false})),
        isFalse,
      );
    });

    test('a deep link goes Home while driver.history is off', () {
      expect(
        historyRedirect(
          '/history',
          _me(features: const {'driver.history': false}),
        ),
        '/home',
      );
      expect(
        historyRedirect(
          '/history/order/x',
          _me(features: const {'driver.history': false}),
        ),
        '/home',
      );
      expect(historyRedirect('/history', _me()), isNull);
      expect(
        historyRedirect(
          '/home',
          _me(features: const {'driver.history': false}),
        ),
        isNull,
      );
      expect(historyRedirect('/history', null), isNull);
    });
  });

  group('look', () {
    for (final dark in [false, true]) {
      for (final scale in [1.0, 1.3]) {
        testWidgets('builds clean in ${dark ? 'dark' : 'light'} at ${scale}x', (
          tester,
        ) async {
          final repo = _Fake(
            pages: (_) => HistoryPage.fromJson({
              'items': [
                _item(1, earning: 32),
                _item(
                  2,
                  outcome: 'failed',
                  reason: 'Customer did not pick up the phone and could not be reached',
                ),
              ],
            }),
          );
          await _pump(
            tester,
            repo: repo,
            brightness: dark ? Brightness.dark : Brightness.light,
            textScale: scale,
          );
          expect(tester.takeException(), isNull);
          await _tap(tester, find.byKey(const Key('history-row-order-1')));
          expect(tester.takeException(), isNull);
        });
      }
    }
  });

  group('model', () {
    test('a row is parsed as the server sends it', () {
      final i = HistoryItem.fromJson(_item(7, earning: 32.5));
      expect(i.outcome, HistoryOutcome.delivered);
      expect(i.hasEarning, isTrue);
      expect(i.took, const Duration(minutes: 32));
      expect(i.dropArea, 'Sector 14');
      expect(HistoryItem.fromJson(_item(8, earning: 0)).hasEarning, isFalse);
    });
  });
}
