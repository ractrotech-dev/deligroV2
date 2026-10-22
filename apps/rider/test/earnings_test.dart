// The Earnings tab: the summary tiles and period switch, the records list and
// each record's detail, payouts, incentives, the statement screen and its
// exports, and the tab itself (third, hidden when `driver.earnings` is off).
// No network: the earnings repository is a fake and the share sheet is a
// recorder.
import 'dart:typed_data';

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/money.dart';
import 'package:deligro_rider/core/statement_export.dart';
import 'package:deligro_rider/data/earnings_repository.dart';
import 'package:deligro_rider/features/earnings/earnings_screen.dart';
import 'package:deligro_rider/features/shell/rider_shell.dart';
import 'package:deligro_rider/models/earnings.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/clock.dart';
import 'package:deligro_rider/state/earnings.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

// 22 Oct 2026, 09:00 IST.
final _now = DateTime.utc(2026, 10, 22, 3, 30);
const _today = '2026-10-22';

EarningsSummary _summary({double pending = 650, LastPayout? last}) =>
    EarningsSummary(
      today: 185,
      week: 940.5,
      month: 3860,
      total: 12450,
      perDeliveryAvg: 41.5,
      deliveriesCounted: 300,
      incentives: 450,
      bonuses: 100,
      adjustments: -30,
      deductions: 50,
      salary: 800,
      paid: 11820,
      pending: pending,
      lastPayout:
          last ??
          const LastPayout(
            amount: 4000,
            paidOn: '2026-10-15',
            reference: 'UTR-77120',
          ),
    );

EarningRecord _delivery({
  String id = 'e1',
  String code = '#A1B2C3',
  String date = '2026-10-21',
  double base = 20,
  double? km = 3.4,
  DistanceSource? source = DistanceSource.road,
  double distanceFee = 12,
  double topup = 0,
  double? tip = 0,
  bool tipInCash = false,
  double? incentive,
  double? deduction,
  double amount = 32,
  bool paid = false,
  String? settledOn,
  String? reference,
  bool reversed = false,
}) => EarningRecord(
  kind: RecordKind.delivery,
  id: id,
  orderId: 'order-$id',
  orderCode: code,
  date: date,
  baseFee: base,
  distanceKm: km,
  distanceSource: source,
  distanceFee: distanceFee,
  minTopup: topup,
  tip: tip,
  tipInCash: tip == null ? null : tipInCash,
  incentive: incentive,
  deduction: deduction,
  amount: amount,
  paid: paid,
  settledOn: settledOn,
  reference: reference,
  reversed: reversed,
);

EarningRecord _reversal({
  String id = 'r1',
  String code = '#A1B2C3',
  String reverses = 'e1',
  double amount = -32,
}) => EarningRecord(
  kind: RecordKind.adjustment,
  id: id,
  orderId: 'order-$reverses',
  orderCode: code,
  date: '2026-10-21',
  amount: amount,
  paid: false,
  note: 'Delivery corrected',
  reversesId: reverses,
);

class _Fake implements EarningsRepository {
  _Fake({EarningsSummary? summary}) : summaryValue = summary ?? _summary();

  EarningsSummary summaryValue;
  Object? summaryError;
  List<EarningRecord> recordItems = [_delivery()];
  String? nextCursor;
  List<EarningRecord> secondPage = [];
  List<Payout> payoutItems = [];
  List<IncentiveProgress> incentiveItems = [];
  Statement? statementValue;
  final recordCalls = <({String from, String to, String? cursor})>[];
  final statementCalls = <({String from, String to})>[];

  @override
  Future<EarningsSummary> summary() async {
    final e = summaryError;
    if (e != null) throw e;
    return summaryValue;
  }

  @override
  Future<RecordsPage> records({
    required String from,
    required String to,
    String? cursor,
    int limit = 50,
  }) async {
    recordCalls.add((from: from, to: to, cursor: cursor));
    if (cursor != null) return RecordsPage(items: secondPage);
    return RecordsPage(items: recordItems, nextCursor: nextCursor);
  }

  @override
  Future<List<Payout>> payouts() async => payoutItems;

  @override
  Future<List<IncentiveProgress>> incentives() async => incentiveItems;

  @override
  Future<Statement> statement(String from, String to) async {
    statementCalls.add((from: from, to: to));
    return statementValue ??
        Statement(
          riderCode: 'DR-0042',
          name: 'Ravi Kumar',
          from: from,
          to: to,
          openingPending: 100,
          earned: 250,
          paid: 300,
          closingPending: 50,
          rows: [
            _delivery(id: 'e1', amount: 32),
            _reversal(),
          ],
        );
  }
}

class _Sharer implements StatementSharer {
  final pdfs = <({Uint8List bytes, String name})>[];
  final csvs = <({String text, String name})>[];

  @override
  Future<void> sharePdf(Uint8List bytes, String fileName) async =>
      pdfs.add((bytes: bytes, name: fileName));

  @override
  Future<void> shareCsv(String csv, String fileName) async =>
      csvs.add((text: csv, name: fileName));
}

RiderMe _me({Map<String, bool> features = const {}}) => RiderMe(
  id: 'rider-1',
  name: 'Ravi Kumar',
  riderCode: 'DR-0042',
  availability: RiderAvailabilityDto.offline,
  phase: 'offline',
  features: features,
);

GoRouter _router(String start) =>
    GoRouter(initialLocation: start, routes: [earningsRoute]);

Future<ProviderContainer> _pump(
  WidgetTester tester, {
  required _Fake repo,
  _Sharer? sharer,
  RiderMe? me,
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  String start = '/earnings',
  // The Earnings page is a long list that builds lazily; tests that look at
  // every tile on it use a tall screen.
  double height = 720,
}) async {
  tester.view.physicalSize = Size(360 * 3, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final container = ProviderContainer(
    overrides: [
      earningsRepoProvider.overrideWithValue(repo),
      clockProvider.overrideWithValue(() => _now),
      statementSharerProvider.overrideWithValue(sharer ?? _Sharer()),
      meProvider.overrideWith((_) async => me ?? _me()),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: buildTheme(brightness),
        routerConfig: _router(start),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
      ),
    ),
  );
  await _settle(tester);
  return container;
}

Future<void> _settle(WidgetTester tester, {int rounds = 6}) async {
  for (var i = 0; i < rounds; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 5)),
    );
    await tester.pump(const Duration(milliseconds: 60));
  }
}

Future<void> _tap(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await _settle(tester);
}

Finder _in(String key, Finder what) =>
    find.descendant(of: find.byKey(Key(key)), matching: what);

TextStyle? _styleOf(WidgetTester tester, Finder f) =>
    tester.widget<Text>(f).style;

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('money', () {
    test('rupees with Indian grouping, paise kept, a real minus sign', () {
      expect(money(120), '₹120');
      expect(money(123456), '₹1,23,456');
      expect(money(37.5), '₹37.50');
      expect(money(940.5), '₹940.50');
      expect(money(0), '₹0');
      expect(money(-120), '−₹120');
      expect(money(-0.5), '−₹0.50');
      expect(signedMoney(30), '+₹30');
      expect(signedMoney(-30), '−₹30');
    });

    test('IST day keys', () {
      expect(
        istDayKey(DateTime.utc(2026, 10, 21, 20, 0)),
        '2026-10-22',
      ); // 01:30 IST
      expect(istDayKey(DateTime.utc(2026, 10, 22, 3, 30)), '2026-10-22');
      expect(addDays('2026-10-01', -1), '2026-09-30');
      expect(formatDay('2026-10-21'), '21 Oct 2026');
    });
  });

  group('models', () {
    test('the summary reads numbers and numeric strings, and a missing last payout', () {
      final s = EarningsSummary.fromJson({
        'today': 185,
        'week': '940.50',
        'month': 3860,
        'total': 12450,
        'perDeliveryAvg': null,
        'deliveriesCounted': 0,
        'incentives': 0,
        'bonuses': 0,
        'adjustments': 0,
        'deductions': 0,
        'salary': 0,
        'paid': 0,
        'pending': -120,
        'lastPayout': null,
      });
      expect(s.week, 940.5);
      expect(s.perDeliveryAvg, isNull);
      expect(s.pending, -120);
      expect(s.lastPayout, isNull);
    });

    test(
      'a record keeps its distance source, reversal link and settlement',
      () {
        final r = EarningRecord.fromJson({
          'kind': 'adjustment',
          'id': 'a1',
          'orderId': 'o1',
          'orderCode': '#ZZ99',
          'date': '2026-10-21',
          'amount': -32,
          'status': 'paid',
          'settledOn': '2026-10-22',
          'reference': 'UTR-1',
          'note': 'Delivery corrected',
          'reversed': false,
          'reversesId': 'e1',
          'distanceSource': null,
        });
        expect(r.isReversal, isTrue);
        expect(r.paid, isTrue);
        expect(r.reference, 'UTR-1');
        expect(r.title, 'Automatic reversal — the delivery was corrected');
        final d = EarningRecord.fromJson({
          'kind': 'delivery',
          'id': 'e1',
          'date': '2026-10-21',
          'amount': 32,
          'status': 'pending',
          'distanceSource': 'estimate',
          'reversed': true,
        });
        expect(d.distanceSource, DistanceSource.estimate);
        expect(d.reversed, isTrue);
        expect(d.paid, isFalse);
      },
    );
  });

  group('Earnings tab', () {
    testWidgets('every figure renders with its rupees', (tester) async {
      await _pump(tester, repo: _Fake(), height: 2400);
      expect(_in('earnings-hero', find.text('₹185')), findsOneWidget);
      // Salaried: no per-delivery figure, whatever the server sends.
      expect(
        _in('tile-average', find.text('Salaried — not paid per delivery')),
        findsOneWidget,
      );
      expect(_in('tile-average', find.textContaining('₹')), findsNothing);
      expect(find.textContaining('41.5'), findsNothing);
      expect(_in('tile-incentives', find.text('₹450')), findsOneWidget);
      expect(_in('tile-bonuses', find.text('₹100')), findsOneWidget);
      expect(_in('tile-adjustments', find.text('−₹30')), findsOneWidget);
      expect(_in('tile-deductions', find.text('−₹50')), findsOneWidget);
      expect(_in('tile-salary', find.text('₹800')), findsOneWidget);
      expect(_in('tile-paid', find.text('₹11,820')), findsOneWidget);
      expect(_in('tile-pending', find.text('₹650')), findsOneWidget);
      expect(_in('tile-last-payout', find.text('₹4,000')), findsOneWidget);
      expect(
        _in('tile-last-payout', find.textContaining('15 Oct 2026')),
        findsOneWidget,
      );
      expect(
        _in('tile-last-payout', find.textContaining('UTR-77120')),
        findsOneWidget,
      );
    });

    testWidgets(
      'the period switch moves between today, week, month and total',
      (tester) async {
        await _pump(tester, repo: _Fake());
        expect(_in('earnings-hero', find.text('Today')), findsOneWidget);
        await _tap(tester, find.byKey(const Key('period-week')));
        expect(_in('earnings-hero', find.text('₹940.50')), findsOneWidget);
        expect(_in('earnings-hero', find.text('This week')), findsOneWidget);
        await _tap(tester, find.byKey(const Key('period-month')));
        expect(_in('earnings-hero', find.text('₹3,860')), findsOneWidget);
        await _tap(tester, find.byKey(const Key('period-total')));
        expect(_in('earnings-hero', find.text('₹12,450')), findsOneWidget);
        expect(_in('earnings-hero', find.text('All time')), findsOneWidget);
        await _tap(tester, find.byKey(const Key('period-today')));
        expect(_in('earnings-hero', find.text('₹185')), findsOneWidget);
      },
    );

    testWidgets(
      'a negative pending shows −₹120 in the deal colour and says what it means',
      (tester) async {
        await _pump(tester, repo: _Fake(summary: _summary(pending: -120)));
        final pending = _in('tile-pending', find.text('−₹120'));
        expect(pending, findsOneWidget);
        expect(_styleOf(tester, pending)?.color, AppColors.light.deal);
        expect(
          _in(
            'tile-pending',
            find.text('You owe Deligro this — it comes off your next payout'),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets('a positive pending is not red and has no warning', (
      tester,
    ) async {
      await _pump(tester, repo: _Fake());
      expect(
        _styleOf(tester, _in('tile-pending', find.text('₹650')))?.color,
        isNot(AppColors.light.deal),
      );
      expect(find.textContaining('You owe Deligro'), findsNothing);
    });

    testWidgets('a rider with no payout yet sees "No payout yet"', (
      tester,
    ) async {
      const s = EarningsSummary(
        today: 0,
        week: 0,
        month: 0,
        total: 0,
        perDeliveryAvg: null,
        deliveriesCounted: 0,
        incentives: 0,
        bonuses: 0,
        adjustments: 0,
        deductions: 0,
        salary: 0,
        paid: 0,
        pending: 0,
        lastPayout: null,
      );
      await _pump(tester, repo: _Fake(summary: s));
      expect(
        _in('tile-last-payout', find.text('No payout yet')),
        findsOneWidget,
      );
      expect(
        _in('tile-average', find.text('Salaried — not paid per delivery')),
        findsOneWidget,
      );
      expect(_in('earnings-hero', find.text('₹0')), findsOneWidget);
    });

    testWidgets(
      'the entry rows open Records, Payouts, Incentives and Statement',
      (tester) async {
        final repo = _Fake();
        await _pump(tester, repo: repo, height: 2400);
        for (final key in [
          'row-records',
          'row-payouts',
          'row-incentives',
          'row-statement',
        ]) {
          expect(find.byKey(Key(key)), findsOneWidget, reason: key);
        }
        await _tap(tester, find.byKey(const Key('row-records')));
        expect(find.text('Records'), findsWidgets);
        expect(repo.recordCalls, isNotEmpty);
      },
    );

    testWidgets('a dead connection says so with a way to retry', (
      tester,
    ) async {
      final repo = _Fake()..summaryError = ApiException(0, 'network');
      await _pump(tester, repo: repo);
      expect(find.text('Try again'), findsOneWidget);
      repo.summaryError = null;
      await _tap(tester, find.text('Try again'));
      expect(_in('earnings-hero', find.text('₹185')), findsOneWidget);
    });

    testWidgets('earnings are never mixed with cash collected', (tester) async {
      await _pump(tester, repo: _Fake());
      expect(find.textContaining('ash'), findsNothing);
    });

    for (final brightness in Brightness.values) {
      testWidgets('lays out at 1.3x text in ${brightness.name} mode', (
        tester,
      ) async {
        final repo = _Fake()
          ..recordItems = [_delivery(), _reversal()]
          ..incentiveItems = [
            const IncentiveProgress(
              ruleId: 'r',
              name: 'Evening rush',
              period: 'daily',
              target: 10,
              done: 7,
              bonus: 100,
              window: '18:00–22:00',
              endsOn: '2026-10-31',
              earned: false,
            ),
          ];
        await _pump(
          tester,
          repo: repo,
          brightness: brightness,
          textScale: 1.3,
          height: 2400,
        );
        expect(tester.takeException(), isNull);
        for (final key in [
          'row-records',
          'row-payouts',
          'row-incentives',
          'row-statement',
        ]) {
          await _tap(tester, find.byKey(Key(key)));
          expect(tester.takeException(), isNull, reason: key);
          await tester.pageBack();
          await _settle(tester);
        }
      });
    }
  });

  group('Records', () {
    Future<_Fake> open(WidgetTester tester, {_Fake? repo}) async {
      final r = repo ?? _Fake();
      await _pump(tester, repo: r, start: '/earnings/records');
      return r;
    }

    testWidgets(
      'asks for the last 31 days and lists order code, date, amount and a paid/pending chip',
      (tester) async {
        final repo = _Fake()
          ..recordItems = [
            _delivery(
              id: 'e1',
              code: '#A1B2C3',
              date: '2026-10-21',
              amount: 32,
            ),
            _delivery(
              id: 'e2',
              code: '#D4E5F6',
              date: '2026-10-20',
              amount: 47.5,
              paid: true,
              settledOn: '2026-10-22',
              reference: 'UTR-1',
            ),
          ];
        await open(tester, repo: repo);
        expect(repo.recordCalls.first.from, '2026-09-22');
        expect(repo.recordCalls.first.to, _today);
        expect(
          _in('record-e1', find.textContaining('#A1B2C3')),
          findsOneWidget,
        );
        expect(_in('record-e1', find.text('₹32')), findsOneWidget);
        expect(_in('record-e1', find.text('Pending')), findsOneWidget);
        expect(_in('record-e1', find.textContaining('21 Oct')), findsOneWidget);
        expect(_in('record-e2', find.text('₹47.50')), findsOneWidget);
        expect(_in('record-e2', find.text('Paid')), findsOneWidget);
      },
    );

    testWidgets('the date range chips ask again for that range', (
      tester,
    ) async {
      final repo = await open(tester);
      await _tap(tester, find.byKey(const Key('range-7')));
      expect(repo.recordCalls.last.from, '2026-10-16');
      expect(repo.recordCalls.last.to, _today);
      await _tap(tester, find.byKey(const Key('range-month')));
      expect(repo.recordCalls.last.from, '2026-10-01');
    });

    testWidgets('Show older loads the next page after the cursor', (
      tester,
    ) async {
      final repo = _Fake()
        ..recordItems = [_delivery(id: 'e1')]
        ..nextCursor = 'cur1'
        ..secondPage = [
          _delivery(id: 'e9', code: '#OLDER9', date: '2026-10-05'),
        ];
      await open(tester, repo: repo);
      expect(find.byKey(const Key('records-more')), findsOneWidget);
      await _tap(tester, find.byKey(const Key('records-more')));
      expect(repo.recordCalls.last.cursor, 'cur1');
      expect(find.byKey(const Key('record-e9')), findsOneWidget);
      expect(find.byKey(const Key('record-e1')), findsOneWidget);
      expect(find.byKey(const Key('records-more')), findsNothing);
    });

    testWidgets(
      'an automatic reversal says so and names its order; the reversed earning is struck through',
      (tester) async {
        final repo = _Fake()
          ..recordItems = [_reversal(), _delivery(reversed: true)];
        await open(tester, repo: repo);
        expect(
          _in(
            'record-r1',
            find.text('Automatic reversal — the delivery was corrected'),
          ),
          findsOneWidget,
        );
        expect(
          _in('record-r1', find.textContaining('#A1B2C3')),
          findsOneWidget,
        );
        expect(_in('record-r1', find.text('−₹32')), findsOneWidget);
        expect(_in('record-e1', find.text('Reversed')), findsOneWidget);
        final amount = _in('record-e1', find.text('₹32'));
        expect(
          _styleOf(tester, amount)?.decoration,
          TextDecoration.lineThrough,
        );
      },
    );

    testWidgets(
      '₹0 delivery rows are not listed; a delivery with a real amount still is',
      (tester) async {
        final repo = _Fake()
          ..recordItems = [
            _delivery(id: 'z1', amount: 0, base: 0, distanceFee: 0),
            _delivery(id: 'z2', amount: 0, base: 0, distanceFee: 0),
            _delivery(id: 'e3', amount: 32),
            const EarningRecord(
              kind: RecordKind.salary,
              id: 's1',
              date: '2026-10-20',
              amount: 18000,
              paid: false,
              note: 'October salary',
            ),
          ];
        await open(tester, repo: repo);
        expect(find.byKey(const Key('record-z1')), findsNothing);
        expect(find.byKey(const Key('record-z2')), findsNothing);
        expect(find.byKey(const Key('record-e3')), findsOneWidget);
        expect(
          _in('record-s1', find.text('Salary — October salary')),
          findsOneWidget,
        );
        expect(_in('record-s1', find.text('₹18,000')), findsOneWidget);
      },
    );

    testWidgets('a range of only ₹0 deliveries reads as empty', (tester) async {
      final repo = _Fake()
        ..recordItems = [
          _delivery(id: 'z1', amount: 0, base: 0, distanceFee: 0),
        ];
      await open(tester, repo: repo);
      expect(find.text('No records in this range'), findsOneWidget);
    });

    testWidgets('an empty range says so', (tester) async {
      final repo = _Fake()..recordItems = [];
      await open(tester, repo: repo);
      expect(find.text('No records in this range'), findsOneWidget);
    });

    testWidgets('tapping a row opens the detail', (tester) async {
      await open(tester);
      await _tap(tester, find.byKey(const Key('record-e1')));
      expect(find.byKey(const Key('record-detail')), findsOneWidget);
    });
  });

  group('Record detail', () {
    Future<void> openDetail(WidgetTester tester, EarningRecord r) async {
      final repo = _Fake()..recordItems = [r];
      await _pump(tester, repo: repo, start: '/earnings/records');
      await _tap(tester, find.byKey(Key('record-${r.id}')));
    }

    Finder row(String label) => find.byKey(Key('field-$label'));

    testWidgets('a paid delivery shows every field', (tester) async {
      await openDetail(
        tester,
        _delivery(
          base: 20,
          km: 3.4,
          distanceFee: 12,
          topup: 5,
          tip: 10,
          tipInCash: false,
          incentive: 100,
          deduction: 20,
          amount: 47,
          paid: true,
          settledOn: '2026-10-22',
          reference: 'UTR-77120',
        ),
      );
      Finder v(String label, String text) =>
          find.descendant(of: row(label), matching: find.textContaining(text));
      expect(v('Order', '#A1B2C3'), findsOneWidget);
      expect(v('Date', '21 Oct 2026'), findsOneWidget);
      expect(v('Base fee', '₹20'), findsOneWidget);
      expect(v('Distance', '3.4 km'), findsOneWidget);
      expect(v('Distance', 'by road'), findsOneWidget);
      expect(v('Distance fee', '₹12'), findsOneWidget);
      expect(v('Minimum top-up', '₹5'), findsOneWidget);
      expect(v('Tip', '₹10'), findsOneWidget);
      expect(v('Incentive', '₹100'), findsOneWidget);
      expect(v('Deduction', '−₹20'), findsOneWidget);
      expect(v('Final amount', '₹47'), findsOneWidget);
      expect(v('Payment', 'Paid'), findsOneWidget);
      expect(v('Settled on', '22 Oct 2026'), findsOneWidget);
      expect(v('Reference', 'UTR-77120'), findsOneWidget);
    });

    testWidgets('a zero tip hides the tip rows', (tester) async {
      await openDetail(tester, _delivery(tip: 0));
      expect(row('Tip'), findsNothing);
      expect(find.textContaining('tip'), findsNothing);
    });

    testWidgets('a cash tip is shown as cash, not in the amount', (
      tester,
    ) async {
      await openDetail(tester, _delivery(tip: 20, tipInCash: true));
      expect(
        find.descendant(of: row('Tip'), matching: find.textContaining('₹20')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: row('Tip'),
          matching: find.textContaining('paid to you in cash'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('an online tip is shown as part of the amount', (tester) async {
      await openDetail(tester, _delivery(tip: 20, tipInCash: false));
      expect(
        find.descendant(
          of: row('Tip'),
          matching: find.textContaining('included'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('an estimated distance says "(estimated)"', (tester) async {
      await openDetail(tester, _delivery(source: DistanceSource.estimate));
      expect(
        find.descendant(
          of: row('Distance'),
          matching: find.textContaining('(estimated)'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('no distance source says "not recorded"', (tester) async {
      await openDetail(tester, _delivery(source: null, km: 0, distanceFee: 0));
      expect(
        find.descendant(
          of: row('Distance'),
          matching: find.textContaining('not recorded'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a pending record has no settlement fields', (tester) async {
      await openDetail(tester, _delivery());
      expect(row('Payment'), findsOneWidget);
      expect(row('Settled on'), findsNothing);
      expect(row('Reference'), findsNothing);
    });

    testWidgets('a reversed delivery is marked Reversed', (tester) async {
      await openDetail(tester, _delivery(reversed: true));
      expect(find.text('Reversed'), findsWidgets);
    });

    testWidgets('an automatic reversal explains itself and shows its order', (
      tester,
    ) async {
      await openDetail(tester, _reversal());
      expect(
        find.text('Automatic reversal — the delivery was corrected'),
        findsWidgets,
      );
      expect(
        find.descendant(
          of: row('Order'),
          matching: find.textContaining('#A1B2C3'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: row('Final amount'),
          matching: find.textContaining('−₹32'),
        ),
        findsOneWidget,
      );
      expect(row('Base fee'), findsNothing);
    });
  });

  group('Payouts', () {
    testWidgets(
      'lists amount, method, reference, dates and how many records each settled',
      (tester) async {
        final repo = _Fake()
          ..payoutItems = const [
            Payout(
              id: 'p1',
              amount: 4000,
              method: 'upi',
              reference: 'UTR-77120',
              paidOn: '2026-10-15',
              periodEnd: '2026-10-14',
              items: 38,
            ),
            Payout(
              id: 'p0',
              amount: 1250.5,
              method: 'cash',
              paidOn: '2026-10-01',
              periodEnd: '2026-09-30',
              items: 1,
            ),
          ];
        await _pump(tester, repo: repo, start: '/earnings/payouts');
        expect(_in('payout-p1', find.text('₹4,000')), findsOneWidget);
        expect(_in('payout-p1', find.textContaining('UPI')), findsOneWidget);
        expect(
          _in('payout-p1', find.textContaining('UTR-77120')),
          findsOneWidget,
        );
        expect(
          _in('payout-p1', find.textContaining('15 Oct 2026')),
          findsOneWidget,
        );
        expect(
          _in('payout-p1', find.textContaining('38 records')),
          findsOneWidget,
        );
        expect(_in('payout-p0', find.text('₹1,250.50')), findsOneWidget);
        expect(
          _in('payout-p0', find.textContaining('1 record')),
          findsOneWidget,
        );
      },
    );

    testWidgets('no payouts yet', (tester) async {
      await _pump(tester, repo: _Fake(), start: '/earnings/payouts');
      expect(find.text('No payouts yet'), findsOneWidget);
    });
  });

  group('Incentives', () {
    IncentiveProgress rule({
      int done = 7,
      bool earned = false,
      String? window = '18:00–22:00',
      String? endsOn = '2026-10-31',
      String period = 'daily',
    }) => IncentiveProgress(
      ruleId: 'r1',
      name: 'Evening rush',
      period: period,
      target: 10,
      done: done,
      bonus: 100,
      window: window,
      endsOn: endsOn,
      earned: earned,
    );

    testWidgets(
      'shows the rule in plain words, the bar at 7 of 10, the window and the end date',
      (tester) async {
        final repo = _Fake()..incentiveItems = [rule()];
        await _pump(tester, repo: repo, start: '/earnings/incentives');
        expect(_in('incentive-r1', find.text('Evening rush')), findsOneWidget);
        expect(
          _in(
            'incentive-r1',
            find.text('Complete 10 deliveries today → ₹100 bonus'),
          ),
          findsOneWidget,
        );
        expect(_in('incentive-r1', find.text('7 of 10')), findsOneWidget);
        expect(
          _in('incentive-r1', find.textContaining('18:00–22:00')),
          findsOneWidget,
        );
        expect(
          _in('incentive-r1', find.textContaining('Ends 31 Oct 2026')),
          findsOneWidget,
        );
        final bar = tester.widget<LinearProgressIndicator>(
          _in('incentive-r1', find.byType(LinearProgressIndicator)),
        );
        expect(bar.value, closeTo(0.7, 1e-9));
        expect(_in('incentive-r1', find.text('Earned')), findsNothing);
      },
    );

    testWidgets(
      'a weekly rule says this week; no window says all day; no end date says so',
      (tester) async {
        final repo = _Fake()
          ..incentiveItems = [
            rule(period: 'weekly', window: null, endsOn: null),
          ];
        await _pump(tester, repo: repo, start: '/earnings/incentives');
        expect(
          _in(
            'incentive-r1',
            find.text('Complete 10 deliveries this week → ₹100 bonus'),
          ),
          findsOneWidget,
        );
        expect(
          _in('incentive-r1', find.textContaining('All day')),
          findsOneWidget,
        );
        expect(
          _in('incentive-r1', find.textContaining('No end date')),
          findsOneWidget,
        );
      },
    );

    testWidgets('an earned rule carries the Earned badge and a full bar', (
      tester,
    ) async {
      final repo = _Fake()..incentiveItems = [rule(done: 10, earned: true)];
      await _pump(tester, repo: repo, start: '/earnings/incentives');
      expect(_in('incentive-r1', find.text('Earned')), findsOneWidget);
      final bar = tester.widget<LinearProgressIndicator>(
        _in('incentive-r1', find.byType(LinearProgressIndicator)),
      );
      expect(bar.value, 1);
    });

    testWidgets('progress never overshoots when more than the target is done', (
      tester,
    ) async {
      final repo = _Fake()..incentiveItems = [rule(done: 12)];
      await _pump(tester, repo: repo, start: '/earnings/incentives');
      final bar = tester.widget<LinearProgressIndicator>(
        _in('incentive-r1', find.byType(LinearProgressIndicator)),
      );
      expect(bar.value, 1);
    });

    testWidgets('no rules in force', (tester) async {
      await _pump(tester, repo: _Fake(), start: '/earnings/incentives');
      expect(find.text('No targets right now'), findsOneWidget);
    });
  });

  group('Statement', () {
    testWidgets(
      'opens on this month and shows the rider, the range, the four totals and the rows',
      (tester) async {
        final repo = _Fake();
        await _pump(tester, repo: repo, start: '/earnings/statement');
        expect(repo.statementCalls.single, (from: '2026-10-01', to: _today));
        expect(find.text('Ravi Kumar'), findsWidgets);
        expect(find.textContaining('DR-0042'), findsWidgets);
        expect(find.textContaining('1 Oct 2026 – 22 Oct 2026'), findsWidgets);
        expect(_in('stmt-opening', find.text('₹100')), findsOneWidget);
        expect(_in('stmt-earned', find.text('₹250')), findsOneWidget);
        expect(_in('stmt-paid', find.text('₹300')), findsOneWidget);
        expect(_in('stmt-closing', find.text('₹50')), findsOneWidget);
        expect(find.byKey(const Key('record-e1')), findsOneWidget);
      },
    );

    testWidgets(
      '₹0 delivery rows are left out of the statement and both files',
      (tester) async {
        final sharer = _Sharer();
        final repo = _Fake()
          ..statementValue = Statement(
            riderCode: 'DR-0042',
            name: 'Ravi Kumar',
            from: '2026-10-01',
            to: _today,
            openingPending: 0,
            earned: 18100,
            paid: 0,
            closingPending: 18100,
            rows: [
              _delivery(id: 'z1', amount: 0, base: 0, distanceFee: 0),
              const EarningRecord(
                kind: RecordKind.salary,
                id: 's1',
                date: '2026-10-20',
                amount: 18000,
                paid: false,
                note: 'October salary',
              ),
              const EarningRecord(
                kind: RecordKind.incentive,
                id: 'i1',
                date: '2026-10-21',
                amount: 100,
                paid: false,
                note: 'Evening rush',
              ),
            ],
          );
        await _pump(
          tester,
          repo: repo,
          sharer: sharer,
          start: '/earnings/statement',
        );
        expect(find.byKey(const Key('record-z1')), findsNothing);
        expect(find.byKey(const Key('record-s1')), findsOneWidget);
        expect(find.byKey(const Key('record-i1')), findsOneWidget);
        await _tap(tester, find.byKey(const Key('statement-csv')));
        final csv = sharer.csvs.single.text;
        expect(csv, contains('October salary'));
        expect(csv, isNot(contains('#A1B2C3')));
      },
    );

    testWidgets('picking another range asks for it', (tester) async {
      final repo = _Fake();
      await _pump(tester, repo: repo, start: '/earnings/statement');
      await _tap(tester, find.byKey(const Key('range-last-month')));
      expect(repo.statementCalls.last, (from: '2026-09-01', to: '2026-09-30'));
      await _tap(tester, find.byKey(const Key('range-7')));
      expect(repo.statementCalls.last, (from: '2026-10-16', to: _today));
    });

    testWidgets(
      'Save PDF hands a PDF named for the rider and range to the share sheet',
      (tester) async {
        final sharer = _Sharer();
        await _pump(
          tester,
          repo: _Fake(),
          sharer: sharer,
          start: '/earnings/statement',
        );
        await tester.runAsync(() async {
          await tester.tap(find.byKey(const Key('statement-pdf')));
          await Future<void>.delayed(const Duration(seconds: 2));
        });
        await _settle(tester);
        expect(sharer.pdfs, hasLength(1));
        expect(
          sharer.pdfs.single.name,
          'deligro-statement-DR-0042-2026-10-01-2026-10-22.pdf',
        );
        expect(String.fromCharCodes(sharer.pdfs.single.bytes.take(5)), '%PDF-');
      },
    );

    testWidgets('Share CSV hands the CSV with the same name', (tester) async {
      final sharer = _Sharer();
      await _pump(
        tester,
        repo: _Fake(),
        sharer: sharer,
        start: '/earnings/statement',
      );
      await _tap(tester, find.byKey(const Key('statement-csv')));
      expect(sharer.csvs, hasLength(1));
      expect(
        sharer.csvs.single.name,
        'deligro-statement-DR-0042-2026-10-01-2026-10-22.csv',
      );
      expect(sharer.csvs.single.text, contains('DR-0042'));
    });
  });

  group('the tab', () {
    GoRouter shellRouter() => GoRouter(
      initialLocation: '/more',
      routes: [
        StatefulShellRoute.indexedStack(
          builder: (_, _, shell) => RiderShell(shell: shell),
          branches: [
            for (final tab in riderTabs)
              StatefulShellBranch(routes: [tab.route]),
          ],
        ),
      ],
    );

    Future<void> pumpShell(WidgetTester tester, RiderMe me) async {
      tester.view.physicalSize = const Size(360 * 3, 720 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final container = ProviderContainer(
        overrides: [
          earningsRepoProvider.overrideWithValue(_Fake()),
          clockProvider.overrideWithValue(() => _now),
          meProvider.overrideWith((_) async => me),
        ],
      );
      addTearDown(container.dispose);
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp.router(
            theme: buildTheme(Brightness.light),
            routerConfig: shellRouter(),
          ),
        ),
      );
      await _settle(tester);
    }

    List<String> labels(WidgetTester tester) => tester
        .widgetList<NavigationDestination>(find.byType(NavigationDestination))
        .map((d) => d.label)
        .toList();

    testWidgets('Earnings is the third tab: Home, Jobs, Earnings, More', (
      tester,
    ) async {
      await pumpShell(tester, _me());
      expect(labels(tester), ['Home', 'Jobs', 'Earnings', 'More']);
    });

    testWidgets('driver.earnings off hides the tab', (tester) async {
      await pumpShell(tester, _me(features: {'driver.earnings': false}));
      expect(labels(tester), ['Home', 'Jobs', 'More']);
      // More is still the selected one, not whatever sits at its old index.
      final bar = tester.widget<NavigationBar>(find.byType(NavigationBar));
      expect(bar.selectedIndex, 2);
    });

    testWidgets('tapping Earnings opens it', (tester) async {
      await pumpShell(tester, _me());
      await _tap(tester, find.text('Earnings').last);
      expect(find.byKey(const Key('earnings-hero')), findsOneWidget);
    });

    test('a deep link to Earnings goes Home while the switch is off', () {
      expect(
        earningsRedirect(
          '/earnings',
          _me(features: {'driver.earnings': false}),
        ),
        '/home',
      );
      expect(
        earningsRedirect(
          '/earnings/records',
          _me(features: {'driver.earnings': false}),
        ),
        '/home',
      );
      expect(earningsRedirect('/earnings', _me()), isNull);
      expect(earningsRedirect('/earnings', null), isNull);
      expect(
        earningsRedirect('/jobs', _me(features: {'driver.earnings': false})),
        isNull,
      );
    });
  });
}
