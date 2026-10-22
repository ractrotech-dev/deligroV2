// Home: the twelve figures, the money switch, the empty rider, the 15 s
// refresh, the taps into Jobs and History, light/dark/1.3x. No network: the
// insights repository is a fake and `meProvider` is overridden.
import 'dart:async';

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/data/insights_repository.dart';
import 'package:deligro_rider/features/history/history_filters.dart';
import 'package:deligro_rider/features/history/history_screen.dart';
import 'package:deligro_rider/features/home/availability_card.dart';
import 'package:deligro_rider/features/home/home_screen.dart';
import 'package:deligro_rider/models/dashboard.dart';
import 'package:deligro_rider/models/insights.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/clock.dart';
import 'package:deligro_rider/state/insights.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

Map<String, dynamic> _json({
  bool money = true,
  bool target = true,
  bool current = true,
  Map<String, dynamic>? today,
}) => {
  'today':
      today ??
      {
        'deliveries': 9,
        'pending': 2,
        'accepted': 3,
        'pickedUp': 4,
        'completed': 5,
        'cancelled': 6,
        'failed': 1,
      },
  'money': money
      ? {
          'today': 185,
          'total': 12450,
          'pending': 650,
          'incentivesThisWeek': 300,
        }
      : null,
  'availability': {
    'isOnline': true,
    'breakUntil': null,
    'onlineSince': '2026-10-22T03:00:00.000Z',
    'lastFixAt': '2026-10-22T06:30:00.000Z',
  },
  'phase': 'online',
  'current': current
      ? {
          'orderId': 'order-1',
          'code': '#A1B2C3',
          'status': 'on_the_way',
          'next': 'Reach the customer',
        }
      : null,
  'nearestTarget': target
      ? {'name': 'Weekly warrior', 'done': 32, 'target': 40, 'bonus': 500}
      : null,
  // 22 Oct 2026, 12:04 IST.
  'updatedAt': '2026-10-22T06:34:00.000Z',
};

Map<String, dynamic> _empty() => _json(
  money: true,
  target: false,
  current: false,
  today: {
    'deliveries': 0,
    'pending': 0,
    'accepted': 0,
    'pickedUp': 0,
    'completed': 0,
    'cancelled': 0,
    'failed': 0,
  },
)..['money'] = {'today': 0, 'total': 0, 'pending': 0, 'incentivesThisWeek': 0};

class _Fake implements InsightsRepository {
  _Fake(this.json);

  Map<String, dynamic> json;
  Object? error;
  int calls = 0;

  /// When set, an answer waits for this before it is given.
  Completer<void>? hold;

  @override
  Future<RiderDashboard> dashboard() async {
    calls++;
    final h = hold;
    if (h != null) await h.future;
    final e = error;
    if (e != null) throw e;
    return RiderDashboard.fromJson(json);
  }

  @override
  Future<HistoryPage> history({
    String? from,
    String? to,
    String? outcome,
    String? cursor,
  }) async => throw UnimplementedError();

  @override
  Future<HistoryDetail> historyDetail(String orderId) async =>
      throw UnimplementedError();

  @override
  Future<RiderPerformance> performance() async => throw UnimplementedError();
}

RiderMe _me({String id = 'rider-1', Map<String, bool> features = const {}}) =>
    RiderMe(
      id: id,
      name: 'Ravi Kumar',
      riderCode: 'DR-0042',
      availability: RiderAvailabilityDto(
        isOnline: true,
        onlineSince: DateTime.utc(2026, 10, 22, 3),
        lastFixAt: DateTime.now(),
      ),
      phase: 'online',
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

class _Where {
  String? last;
  late ProviderContainer container;
}

Future<_Where> _pump(
  WidgetTester tester, {
  required _Fake repo,
  RiderMe? me,
  RiderMe Function()? meFn,
  DateTime? now,
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  double height = 2600,
}) async {
  tester.view.physicalSize = Size(360 * 3, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final where = _Where();
  final router = GoRouter(
    initialLocation: '/home',
    routes: [
      GoRoute(path: '/home', builder: (_, _) => const HomeScreen()),
      GoRoute(
        path: '/jobs',
        builder: (_, s) {
          where.last = s.uri.toString();
          return const Scaffold(body: Text('JOBS PAGE'));
        },
      ),
      GoRoute(
        path: '/history',
        builder: (_, s) {
          where.last = s.uri.toString();
          return const Scaffold(body: Text('HISTORY PAGE'));
        },
      ),
    ],
  );
  SharedPreferences.setMockInitialValues({});
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      // 22 Oct 2026, 12:30 IST.
      clockProvider.overrideWithValue(
        () => now ?? DateTime.utc(2026, 10, 22, 7, 0),
      ),
      insightsRepoProvider.overrideWithValue(repo),
      meProvider.overrideWith((_) async => meFn?.call() ?? me ?? _me()),
    ],
  );
  addTearDown(container.dispose);
  where.container = container;
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
  return where;
}

Finder _in(String key, Finder what) =>
    find.descendant(of: find.byKey(Key(key)), matching: what);

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('the twelve figures', () {
    testWidgets('all twelve are there with the servers values', (tester) async {
      await _pump(tester, repo: _Fake(_json()));
      // 1-6
      expect(_in('tile-deliveries', find.text('9')), findsOneWidget);
      expect(
        _in('tile-deliveries', find.text("Today's deliveries")),
        findsOneWidget,
      );
      expect(
        _in('tile-deliveries', find.text('Accepted today')),
        findsOneWidget,
      );
      expect(_in('tile-pending', find.text('2')), findsOneWidget);
      expect(_in('tile-pending', find.text('Pending')), findsOneWidget);
      expect(_in('tile-accepted', find.text('3')), findsOneWidget);
      expect(_in('tile-accepted', find.text('Accepted')), findsOneWidget);
      expect(_in('tile-picked-up', find.text('4')), findsOneWidget);
      expect(_in('tile-picked-up', find.text('Picked up')), findsOneWidget);
      expect(_in('tile-completed', find.text('5')), findsOneWidget);
      expect(_in('tile-completed', find.text('Completed')), findsOneWidget);
      expect(_in('tile-cancelled', find.text('6')), findsOneWidget);
      expect(_in('tile-cancelled', find.text('Cancelled')), findsOneWidget);
      expect(_in('tile-cancelled', find.text('1 failed')), findsOneWidget);
      // 7-9
      expect(_in('tile-earnings-today', find.text('₹185')), findsOneWidget);
      expect(_in('tile-earnings-total', find.text('₹12,450')), findsOneWidget);
      expect(_in('tile-earnings-pending', find.text('₹650')), findsOneWidget);
      // 10
      expect(find.byType(AvailabilityCard), findsOneWidget);
      // 11
      expect(_in('current-delivery', find.text('#A1B2C3')), findsOneWidget);
      expect(_in('current-delivery', find.text('On the way')), findsOneWidget);
      expect(
        _in('current-delivery', find.text('Reach the customer')),
        findsOneWidget,
      );
      // 12
      expect(_in('incentives-card', find.text('₹300')), findsOneWidget);
      expect(
        _in('incentives-card', find.text('Weekly warrior')),
        findsOneWidget,
      );
      expect(_in('incentives-card', find.text('32 of 40')), findsOneWidget);
      expect(
        tester
            .widget<LinearProgressIndicator>(
              _in('incentives-card', find.byType(LinearProgressIndicator)),
            )
            .value,
        closeTo(0.8, 1e-9),
      );
      // the header and the refresh time
      expect(find.text('Ravi Kumar'), findsOneWidget);
      expect(find.text('DR-0042'), findsOneWidget);
      expect(find.text('Updated 12:04 PM'), findsOneWidget);
    });

    testWidgets('the money says what the Earnings tab says', (tester) async {
      await _pump(tester, repo: _Fake(_json()));
      const salary = 'Salary, bonuses and incentives, less deductions';
      expect(_in('tile-earnings-today', find.text(salary)), findsOneWidget);
      expect(_in('tile-earnings-total', find.text(salary)), findsOneWidget);
      expect(
        _in(
          'tile-earnings-pending',
          find.text('Earned and waiting for your next payout'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('owing says it comes off the next payout', (tester) async {
      final j = _json();
      (j['money'] as Map<String, dynamic>)['pending'] = -120;
      await _pump(tester, repo: _Fake(j));
      expect(
        _in(
          'tile-earnings-pending',
          find.text('You owe Deligro this — it comes off your next payout'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('earnings off hides 7, 8, 9 and 12 and keeps the counts', (
      tester,
    ) async {
      await _pump(tester, repo: _Fake(_json(money: false)));
      expect(find.byKey(const Key('tile-earnings-today')), findsNothing);
      expect(find.byKey(const Key('tile-earnings-total')), findsNothing);
      expect(find.byKey(const Key('tile-earnings-pending')), findsNothing);
      expect(find.byKey(const Key('incentives-card')), findsNothing);
      expect(find.textContaining('₹'), findsNothing);
      expect(find.byKey(const Key('tile-deliveries')), findsOneWidget);
      expect(find.byKey(const Key('tile-cancelled')), findsOneWidget);
      expect(find.byType(AvailabilityCard), findsOneWidget);
      expect(find.byKey(const Key('current-delivery')), findsOneWidget);
    });

    testWidgets('the riders own switch hides the money even if sent', (
      tester,
    ) async {
      await _pump(
        tester,
        repo: _Fake(_json()),
        me: _me(features: const {'driver.earnings': false}),
      );
      expect(find.byKey(const Key('tile-earnings-today')), findsNothing);
      expect(find.byKey(const Key('incentives-card')), findsNothing);
      expect(find.textContaining('₹'), findsNothing);
    });

    testWidgets('a brand-new rider sees zeros and dashes, no errors', (
      tester,
    ) async {
      await _pump(tester, repo: _Fake(_empty()));
      for (final k in [
        'deliveries',
        'pending',
        'accepted',
        'picked-up',
        'completed',
        'cancelled',
      ]) {
        expect(_in('tile-$k', find.text('0')), findsOneWidget, reason: k);
      }
      expect(find.textContaining('failed'), findsNothing);
      expect(_in('tile-earnings-today', find.text('₹0')), findsOneWidget);
      expect(_in('tile-earnings-total', find.text('₹0')), findsOneWidget);
      expect(_in('tile-earnings-pending', find.text('₹0')), findsOneWidget);
      expect(find.text('No active delivery'), findsOneWidget);
      expect(_in('incentives-card', find.text('₹0')), findsOneWidget);
      expect(_in('incentives-card', find.text('—')), findsOneWidget);
      expect(find.textContaining('NaN'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('money owed shows as a minus', (tester) async {
      final j = _json();
      (j['money'] as Map<String, dynamic>)['pending'] = -120;
      await _pump(tester, repo: _Fake(j));
      expect(_in('tile-earnings-pending', find.text('−₹120')), findsOneWidget);
    });
  });

  group('refresh', () {
    testWidgets('asks again every 15 seconds while Home shows', (tester) async {
      final repo = _Fake(_json());
      await _pump(tester, repo: repo);
      expect(repo.calls, 1);
      await tester.pump(const Duration(seconds: 14));
      expect(repo.calls, 1);
      await tester.pump(const Duration(seconds: 1));
      await _settle(tester);
      expect(repo.calls, 2);
      repo.json = _json(
        today: {
          'deliveries': 10,
          'pending': 0,
          'accepted': 0,
          'pickedUp': 0,
          'completed': 7,
          'cancelled': 0,
          'failed': 0,
        },
      );
      await tester.pump(const Duration(seconds: 15));
      await _settle(tester);
      expect(repo.calls, 3);
      expect(_in('tile-deliveries', find.text('10')), findsOneWidget);
    });

    testWidgets('a failed refresh keeps the last figures and says so', (
      tester,
    ) async {
      final repo = _Fake(_json());
      await _pump(tester, repo: repo);
      repo.error = ApiException(0, 'offline');
      await tester.pump(const Duration(seconds: 15));
      await _settle(tester);
      expect(_in('tile-deliveries', find.text('9')), findsOneWidget);
      expect(find.byKey(const Key('dashboard-stale')), findsOneWidget);
    });

    testWidgets('no answer yet and an error: a retry, not a blank page', (
      tester,
    ) async {
      final repo = _Fake(_json())..error = ApiException(500, 'server_error');
      await _pump(tester, repo: repo);
      expect(find.byKey(const Key('dashboard-retry')), findsOneWidget);
      expect(find.byType(AvailabilityCard), findsOneWidget);
      repo.error = null;
      await tester.tap(find.byKey(const Key('dashboard-retry')));
      await _settle(tester);
      expect(find.byKey(const Key('dashboard-retry')), findsNothing);
      expect(_in('tile-deliveries', find.text('9')), findsOneWidget);
    });

    testWidgets('pull to refresh asks again', (tester) async {
      final repo = _Fake(_json());
      await _pump(tester, repo: repo, height: 700);
      await tester.drag(find.byType(ListView).first, const Offset(0, 400));
      await _settle(tester, rounds: 10);
      expect(repo.calls, greaterThan(1));
    });
  });

  group('taps', () {
    testWidgets('pending, accepted and picked up go to Jobs', (tester) async {
      for (final k in ['pending', 'accepted', 'picked-up']) {
        final where = await _pump(tester, repo: _Fake(_json()));
        await tester.tap(find.byKey(Key('tile-$k')));
        await _settle(tester);
        expect(where.last, '/jobs', reason: k);
        expect(find.text('JOBS PAGE'), findsOneWidget);
      }
    });

    testWidgets('deliveries, completed and cancelled go to History, filtered', (
      tester,
    ) async {
      final cases = <String, Map<String, String>>{
        'deliveries': {'range': 'today'},
        'completed': {'range': 'today', 'outcome': 'delivered'},
        // Cancelled counts failed and reassigned jobs too: History opens on
        // every job not delivered.
        'cancelled': {'range': 'today', 'outcome': 'not_delivered'},
      };
      for (final e in cases.entries) {
        final where = await _pump(tester, repo: _Fake(_json()));
        await tester.tap(find.byKey(Key('tile-${e.key}')));
        await _settle(tester);
        final uri = Uri.parse(where.last!);
        expect(uri.path, '/history', reason: e.key);
        final q = {...uri.queryParameters}..remove('n');
        expect(q, e.value, reason: e.key);
      }
    });

    testWidgets('with History switched off the count tiles do not navigate', (
      tester,
    ) async {
      final where = await _pump(
        tester,
        repo: _Fake(_json()),
        me: _me(features: const {'driver.history': false}),
      );
      await tester.tap(find.byKey(const Key('tile-completed')));
      await _settle(tester);
      expect(where.last, isNull);
      expect(find.text('HISTORY PAGE'), findsNothing);
    });

    testWidgets('the current delivery opens Jobs', (tester) async {
      final where = await _pump(tester, repo: _Fake(_json()));
      await tester.tap(find.byKey(const Key('current-delivery')));
      await _settle(tester);
      expect(where.last, '/jobs');
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
            repo: _Fake(_json()),
            brightness: dark ? Brightness.dark : Brightness.light,
            textScale: scale,
          );
          expect(tester.takeException(), isNull);
          expect(find.byKey(const Key('tile-cancelled')), findsOneWidget);
          expect(find.byKey(const Key('incentives-card')), findsOneWidget);
        });
      }
    }
  });

  group('another rider on the same phone', () {
    Map<String, dynamic> riderA() {
      final j = _json(
        today: {
          'deliveries': 9,
          'pending': 0,
          'accepted': 0,
          'pickedUp': 0,
          'completed': 7,
          'cancelled': 0,
          'failed': 0,
        },
      );
      (j['money'] as Map<String, dynamic>)['total'] = 9999;
      return j;
    }

    testWidgets(
      'while their request is held, the last riders figures are gone',
      (tester) async {
        var who = 'rider-a';
        final repo = _Fake(riderA());
        final where = await _pump(
          tester,
          repo: repo,
          meFn: () => _me(id: who),
        );
        expect(_in('tile-earnings-total', find.text('₹9,999')), findsOneWidget);
        repo
          ..hold = Completer<void>()
          ..json = _json();
        who = 'rider-b';
        where.container.invalidate(meProvider);
        await _settle(tester);
        expect(find.text('₹9,999'), findsNothing);
        expect(find.byKey(const Key('tile-completed')), findsNothing);
        expect(find.byType(CircularProgressIndicator), findsOneWidget);
        // Their own answer, when it comes, is what shows.
        repo.hold!.complete();
        await _settle(tester);
        expect(_in('tile-completed', find.text('5')), findsOneWidget);
        expect(find.text('₹9,999'), findsNothing);
      },
    );

    testWidgets(
      'and when their request fails, nothing of the last rider shows',
      (tester) async {
        var who = 'rider-a';
        final repo = _Fake(riderA());
        final where = await _pump(
          tester,
          repo: repo,
          meFn: () => _me(id: who),
        );
        expect(_in('tile-earnings-total', find.text('₹9,999')), findsOneWidget);
        repo.error = ApiException(500, 'server_error');
        who = 'rider-b';
        where.container.invalidate(meProvider);
        await _settle(tester);
        expect(find.text('₹9,999'), findsNothing);
        expect(find.byKey(const Key('tile-completed')), findsNothing);
        expect(find.byKey(const Key('dashboard-retry')), findsOneWidget);
        // Later refreshes that fail do not bring them back either.
        await tester.pump(const Duration(seconds: 15));
        await _settle(tester);
        expect(find.text('₹9,999'), findsNothing);
      },
    );
  });

  group('Home on the phones lifecycle', () {
    testWidgets('a phone whose app is not in front does not poll', (
      tester,
    ) async {
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        ),
      );
      final repo = _Fake(_json());
      await _pump(tester, repo: repo);
      expect(repo.calls, 1);
      await tester.pump(const Duration(seconds: 16));
      await tester.pump(const Duration(seconds: 16));
      expect(repo.calls, 1);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await _settle(tester);
      expect(repo.calls, 2);
    });
  });

  group('figures from an earlier visit', () {
    testWidgets('are asked for again the moment Home comes back', (
      tester,
    ) async {
      final repo = _Fake(_json());
      final where = await _pump(tester, repo: repo);
      expect(repo.calls, 1);
      expect(_in('tile-completed', find.text('5')), findsOneWidget);
      // The rider signs out and back in: Home is torn down and built again
      // over the same app session.
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      repo.json = _json(
        today: {
          'deliveries': 11,
          'pending': 0,
          'accepted': 0,
          'pickedUp': 0,
          'completed': 8,
          'cancelled': 0,
          'failed': 0,
        },
      );
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: where.container,
          child: MaterialApp.router(
            theme: buildTheme(Brightness.light),
            routerConfig: GoRouter(
              initialLocation: '/home',
              routes: [
                GoRoute(path: '/home', builder: (_, _) => const HomeScreen()),
              ],
            ),
          ),
        ),
      );
      await _settle(tester);
      expect(repo.calls, 2);
      expect(_in('tile-completed', find.text('8')), findsOneWidget);
    });

    testWidgets('the first time Home shows asks only once', (tester) async {
      final repo = _Fake(_json());
      await _pump(tester, repo: repo);
      await _settle(tester);
      expect(repo.calls, 1);
    });

    testWidgets('figures from another day say which day', (tester) async {
      final j = _json();
      j['updatedAt'] = '2026-10-21T06:34:00.000Z';
      await _pump(tester, repo: _Fake(j));
      expect(find.text('Updated 21 Oct, 12:04 PM'), findsOneWidget);
    });

    testWidgets('figures from today show just the time', (tester) async {
      await _pump(tester, repo: _Fake(_json()));
      expect(find.text('Updated 12:04 PM'), findsOneWidget);
    });
  });

  group('links into History', () {
    test('every link from Home is new, so the same tile applies again', () {
      final a = historyLink(range: HistoryRange.today, outcome: 'delivered');
      final b = historyLink(range: HistoryRange.today, outcome: 'delivered');
      expect(Uri.parse(a).queryParameters['n'], isNotNull);
      expect(
        Uri.parse(a).queryParameters['n'],
        isNot(Uri.parse(b).queryParameters['n']),
      );
      expect(Uri.parse(a).queryParameters['range'], 'today');
      expect(Uri.parse(a).queryParameters['outcome'], 'delivered');
      expect(
        Uri.parse(historyLink(range: HistoryRange.today)).queryParameters
            .containsKey('outcome'),
        isFalse,
      );
    });
  });

  group('model', () {
    test('an unknown delivery status is shown generally, not thrown', () {
      final c = DashCurrent.fromJson({
        'orderId': 'x',
        'code': '#X',
        'status': 'teleporting',
        'next': 'Do it',
      });
      expect(c.status, isNull);
    });

    test('a target with nothing to do never divides by zero', () {
      const t = NearestTarget(name: 'x', done: 3, target: 0, bonus: 10);
      expect(t.fraction, 0);
    });
  });
}
