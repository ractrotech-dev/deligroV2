// The Cash screen under More: every figure, the over-limit styling and reason,
// the deposit sheet (prefilled amount, UPI needs its reference, receipt photo,
// manager), the deposits list with the manager's note and withdraw, day-by-day
// status with a dispute, order-wise collections, the More badge and the Home
// strip. No network: the cash repository is a fake.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:deligro_rider/core/action_queue.dart';
import 'package:deligro_rider/core/active_cache.dart';
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/receipt_photo.dart';
import 'package:deligro_rider/data/jobs_repository.dart';
import 'package:deligro_rider/data/cash_repository.dart';
import 'package:deligro_rider/data/fixtures/fixture_cash.dart';
import 'package:deligro_rider/features/cash/cash_screen.dart';
import 'package:deligro_rider/features/cash/cash_strip.dart';
import 'package:deligro_rider/features/more/more_screen.dart';
import 'package:deligro_rider/models/cash.dart';
import 'package:deligro_rider/models/jobs.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/cash.dart';
import 'package:deligro_rider/state/clock.dart';
import 'package:deligro_rider/state/jobs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

// 22 Oct 2026, 09:00 IST.
final _now = DateTime.utc(2026, 10, 22, 3, 30);

CashSummary _summary({
  int toCollect = 450,
  int collectedToday = 1200,
  int depositedToday = 300,
  int pending = 2400,
  int awaiting = 0,
  bool overLimit = false,
  bool overHours = false,
  int limit = 5000,
  int maxHours = 24,
  List<CashDay>? days,
}) => CashSummary(
  toCollect: toCollect,
  collectedToday: collectedToday,
  depositedToday: depositedToday,
  collectedTotal: pending + 3000,
  depositedTotal: 3000,
  pending: pending,
  submittedAwaiting: awaiting,
  oldestUndepositedAt: pending > 0 ? DateTime.utc(2026, 10, 21, 3) : null,
  overLimit: overLimit,
  overHours: overHours,
  limit: limit,
  maxHours: maxHours,
  days:
      days ??
      const [
        CashDay(
          day: '2026-10-22',
          collected: 1200,
          deposited: 300,
          status: DayStatus.pending,
        ),
        CashDay(
          day: '2026-10-21',
          collected: 900,
          deposited: 900,
          status: DayStatus.settled,
        ),
        CashDay(
          day: '2026-10-20',
          collected: 1500,
          deposited: 1000,
          status: DayStatus.disputed,
          note: 'Only 1000 reached me',
        ),
      ],
);

CashDeposit _deposit({
  String id = 'd1',
  int amount = 600,
  bool upi = false,
  DepositStatus status = DepositStatus.submitted,
  String? decisionNote,
  String? reference,
  String? manager = 'Anil Verma',
}) => CashDeposit(
  id: id,
  amount: amount,
  upi: upi,
  status: status,
  createdAt: DateTime.utc(2026, 10, 22, 2),
  managerName: manager,
  reference: reference,
  decisionNote: decisionNote,
);

CashCollection _collection(
  String id,
  int amount, {
  bool online = false,
  String? status,
}) => CashCollection(
  orderId: id,
  code: '#$id',
  at: DateTime.utc(2026, 10, 21, 12),
  amount: amount,
  online: online,
  status: status ?? (online ? 'paid_online' : 'collected'),
);

class _Fake implements CashRepository {
  _Fake({CashSummary? summary}) : summaryValue = summary ?? _summary();

  CashSummary summaryValue;
  Object? summaryError;
  List<CashDeposit> depositItems = [];
  List<CashDispute> disputeItems = [];
  List<CashManager> managerItems = const [
    CashManager(id: 'm1', name: 'Anil Verma'),
    CashManager(id: 'm2', name: 'Meera Joshi'),
  ];
  List<CashCollection> collectionItems = [];

  final submitted =
      <
        ({
          int amount,
          bool upi,
          String? managerId,
          String? reference,
          String? note,
          File? photo,
        })
      >[];
  Object? submitError;
  final withdrawn = <String>[];
  Object? withdrawError;
  final raised = <({String day, String message, int? claimed})>[];
  Object? disputeError;
  final collectionCalls = <({String from, String to})>[];

  @override
  Future<CashSummary> summary() async {
    final e = summaryError;
    if (e != null) throw e;
    return summaryValue;
  }

  @override
  Future<CollectionsPage> collections({
    required String from,
    required String to,
    String? cursor,
    int limit = 50,
  }) async {
    collectionCalls.add((from: from, to: to));
    return CollectionsPage(items: collectionItems);
  }

  @override
  Future<List<CashDeposit>> deposits() async => depositItems;

  @override
  Future<List<CashManager>> managers() async => managerItems;

  @override
  Future<String> submitDeposit({
    required int amount,
    required bool upi,
    String? managerId,
    String? reference,
    String? note,
    File? photo,
  }) async {
    final e = submitError;
    if (e != null) throw e;
    submitted.add((
      amount: amount,
      upi: upi,
      managerId: managerId,
      reference: reference,
      note: note,
      photo: photo,
    ));
    return 'new-deposit';
  }

  @override
  Future<void> withdrawDeposit(String id) async {
    final e = withdrawError;
    if (e != null) throw e;
    withdrawn.add(id);
    depositItems = [
      for (final d in depositItems)
        if (d.id == id)
          _deposit(id: id, amount: d.amount, status: DepositStatus.withdrawn)
        else
          d,
    ];
  }

  @override
  Future<List<CashDispute>> disputes() async => disputeItems;

  @override
  Future<String> raiseDispute({
    required String day,
    required String message,
    int? claimedAmount,
  }) async {
    final e = disputeError;
    if (e != null) throw e;
    raised.add((day: day, message: message, claimed: claimedAmount));
    return 'new-dispute';
  }
}

/// A repository whose deposit waits for the test to let it through.
class _GatedFake extends _Fake {
  _GatedFake(this.gate);

  final Completer<void> gate;

  @override
  Future<String> submitDeposit({
    required int amount,
    required bool upi,
    String? managerId,
    String? reference,
    String? note,
    File? photo,
  }) async {
    await gate.future;
    return super.submitDeposit(
      amount: amount,
      upi: upi,
      managerId: managerId,
      reference: reference,
      note: note,
      photo: photo,
    );
  }
}

RiderMe _me() => RiderMe(
  id: 'rider-1',
  name: 'Ravi Kumar',
  riderCode: 'DR-0042',
  availability: RiderAvailabilityDto.offline,
  phase: 'offline',
);

/// Who is signed in, switchable by a test.
class _Uid extends Notifier<String?> {
  @override
  String? build() => 'rider-1';

  void set(String? id) => state = id;
}

final _uidProvider = NotifierProvider<_Uid, String?>(_Uid.new);

/// A board that never asks the network; a test says what the rider carries.
class _StubBoard extends BoardNotifier {
  @override
  BoardState build() => const BoardState();

  void carry(RiderActive? a) => state = BoardState(board: RiderBoard(active: a));

  @override
  Future<void> refresh({bool afterAction = false}) async {}
}

class _QueueRepo implements JobsRepository {
  @override
  Future<ActionOutcome> act(QueuedAction a) async => ActionOutcome(
    ActionOutcomeKind.applied,
    actionId: a.actionId,
    orderId: a.orderId,
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

RiderActive _active(String status) => RiderActive.fromJson({
  'orderId': 'order-1',
  'deliveryId': 'del-1',
  'code': '#A1',
  'status': status,
  'shop': {'name': 'Shop'},
  'drop': {'name': 'Home'},
  'payment': {'instruction': 'collect', 'collectAmount': 450},
});

/// The same shell the real app has: Cash lives inside a StatefulShellRoute,
/// so a Navigator.pop with the wrong context pops the screen.
GoRouter _shellRouter(String start) => GoRouter(
  initialLocation: start,
  routes: [
    StatefulShellRoute.indexedStack(
      builder: (_, _, shell) => Scaffold(body: shell),
      branches: [
        StatefulShellBranch(
          routes: [
            GoRoute(
              path: '/home',
              builder: (_, _) => const Scaffold(body: CashInHandStrip()),
            ),
          ],
        ),
        StatefulShellBranch(routes: [moreRoute]),
      ],
    ),
  ],
);

GoRouter _router(String start) => GoRouter(
  initialLocation: start,
  routes: [
    moreRoute,
    GoRoute(
      path: '/home',
      builder: (_, _) => const Scaffold(body: CashInHandStrip()),
    ),
  ],
);

Future<ProviderContainer> _pump(
  WidgetTester tester, {
  required _Fake repo,
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  String start = cashPath,
  double height = 1600,
  Future<File?> Function({required bool camera})? picker,
  bool shell = false,
  JobsRepository? queueRepo,
}) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  final queue = ActionQueue(
    queueRepo ?? _QueueRepo(),
    prefs,
    ActiveDeliveryCache(prefs),
  );
  addTearDown(queue.dispose);
  tester.view.physicalSize = Size(360 * 3, height * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final container = ProviderContainer(
    overrides: [
      cashRepoProvider.overrideWithValue(repo),
      clockProvider.overrideWithValue(() => _now),
      meProvider.overrideWith((_) async => _me()),
      userIdProvider.overrideWith((ref) => ref.watch(_uidProvider)),
      boardProvider.overrideWith(_StubBoard.new),
      actionQueueProvider.overrideWithValue(queue),
      if (picker != null) receiptPickerProvider.overrideWithValue(picker),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        theme: buildTheme(brightness),
        routerConfig: shell ? _shellRouter(start) : _router(start),
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

Future<void> _enter(WidgetTester tester, String key, String text) async {
  final f = find.byKey(Key(key));
  await tester.ensureVisible(f);
  await tester.enterText(f, text);
  await tester.pump();
}

Finder _in(String key, Finder what) =>
    find.descendant(of: find.byKey(Key(key)), matching: what);

Color? _colorOf(WidgetTester tester, Finder f) =>
    tester.widget<Text>(f).style?.color;

final _jpegBytes = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46];
final _pngBytes = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

/// A real file in a fresh temp folder; the extension says nothing about the bytes.
File _receiptFile(String ext, List<int> bytes, {int pad = 0}) {
  final dir = Directory.systemTemp.createTempSync('receipt');
  addTearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });
  return File('${dir.path}/pick.$ext')
    ..writeAsBytesSync([...bytes, ...List.filled(pad, 0)]);
}

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('models', () {
    test('the summary reads every figure, the thresholds and the days', () {
      final s = CashSummary.fromJson({
        'toCollect': 450,
        'collectedToday': 600,
        'depositedToday': 600,
        'collectedTotal': 1000,
        'depositedTotal': 600,
        'pending': 400,
        'submittedAwaiting': 200,
        'oldestUndepositedAt': '2026-10-22T03:30:00.000Z',
        'overLimit': true,
        'overHours': false,
        'limit': 5000,
        'maxHours': 24,
        'days': [
          {
            'day': '2026-10-21',
            'collected': 400,
            'deposited': 0,
            'status': 'disputed',
            'note': 'Short by 100',
          },
        ],
      });
      expect(s.pending, 400);
      expect(s.available, 200);
      expect(s.overLimit, isTrue);
      expect(s.limit, 5000);
      expect(s.days.single.status, DayStatus.disputed);
      expect(s.days.single.note, 'Short by 100');
      expect(s.neverCollected, isFalse);
    });

    test('a rider with no COD ever reads zeros and no days', () {
      final s = CashSummary.fromJson({
        'toCollect': 0,
        'collectedToday': 0,
        'depositedToday': 0,
        'collectedTotal': 0,
        'depositedTotal': 0,
        'pending': 0,
        'submittedAwaiting': 0,
        'oldestUndepositedAt': null,
        'overLimit': false,
        'overHours': false,
        'limit': 5000,
        'maxHours': 24,
        'days': [],
      });
      expect(s.neverCollected, isTrue);
      expect(s.available, 0);
      expect(s.oldestUndepositedAt, isNull);
    });

    test('collections, deposits and disputes', () {
      final page = CollectionsPage.fromJson({
        'items': [
          {
            'orderId': 'o1',
            'code': '#A1',
            'at': '2026-10-22T07:30:00.000Z',
            'amount': 250,
            'method': 'cod',
            'status': 'collected',
          },
          {
            'orderId': 'o2',
            'code': '#A2',
            'at': '2026-10-22T08:30:00.000Z',
            'amount': 380,
            'method': 'online',
            'status': 'paid_online',
          },
        ],
        'nextCursor': 'abc',
      });
      expect(page.items.first.online, isFalse);
      expect(page.items.last.online, isTrue);
      expect(page.nextCursor, 'abc');

      final d = CashDeposit.fromJson({
        'id': 'x',
        'amount': 600,
        'method': 'upi',
        'status': 'disputed',
        'managerId': null,
        'managerName': 'Anil Verma',
        'reference': '4123',
        'note': null,
        'hasReceipt': true,
        'decisionNote': 'Only 400 reached me',
        'decidedAt': null,
        'createdAt': '2026-10-22T01:00:00.000Z',
      });
      expect(d.upi, isTrue);
      expect(d.status, DepositStatus.disputed);
      expect(d.decisionNote, 'Only 400 reached me');

      final x = CashDispute.fromJson({
        'id': 'z',
        'day': '2026-10-21',
        'claimedAmount': 700,
        'message': 'Wrong',
        'status': 'resolved',
        'resolution': 'Fixed',
        'createdAt': '2026-10-22T01:00:00.000Z',
      });
      expect(x.open, isFalse);
      expect(x.claimedAmount, 700);
    });

    test('the fixture backend refuses to build in a release build', () {
      expect(
        () => FixtureCashRepository.create(releaseMode: true),
        throwsStateError,
      );
    });
  });

  group('the Cash screen', () {
    testWidgets('shows every figure and says it is not earnings', (t) async {
      final repo = _Fake(summary: _summary(awaiting: 600));
      repo.depositItems = [_deposit(amount: 600)];
      await _pump(t, repo: repo);

      expect(find.byKey(const Key('cash-not-earnings')), findsOneWidget);
      expect(find.textContaining('not part of your earnings'), findsOneWidget);
      expect(_in('cash-pending', find.text('₹2,400')), findsOneWidget);
      expect(find.text('Cash in hand'), findsOneWidget);
      expect(_in('tile-to-collect', find.text('₹450')), findsOneWidget);
      expect(_in('tile-collected-today', find.text('₹1,200')), findsOneWidget);
      expect(_in('tile-deposited-today', find.text('₹300')), findsOneWidget);
      expect(_in('tile-awaiting', find.text('₹600')), findsOneWidget);
      expect(find.byKey(const Key('cash-awaiting-note')), findsOneWidget);
      expect(find.text('₹600 of this is waiting for a manager.'), findsOneWidget);
      // Within limits: no warning.
      expect(find.byKey(const Key('cash-over-reason')), findsNothing);
      expect(
        _colorOf(t, find.byKey(const Key('cash-pending-amount'))),
        AppColors.light.ink,
      );
    });

    testWidgets('over the limit: red, with the reason', (t) async {
      await _pump(
        t,
        repo: _Fake(summary: _summary(pending: 6100, overLimit: true)),
      );
      expect(
        _colorOf(t, find.byKey(const Key('cash-pending-amount'))),
        AppColors.light.deal,
      );
      expect(find.text('More than the ₹5,000 limit.'), findsOneWidget);
    });

    testWidgets('held too long: red, with the reason', (t) async {
      await _pump(t, repo: _Fake(summary: _summary(overHours: true)));
      expect(
        _colorOf(t, find.byKey(const Key('cash-pending-amount'))),
        AppColors.light.deal,
      );
      expect(
        find.text('Some of it has been with you for over 24 hours.'),
        findsOneWidget,
      );
    });

    testWidgets('both reasons show together', (t) async {
      await _pump(
        t,
        repo: _Fake(summary: _summary(overLimit: true, overHours: true)),
      );
      expect(find.byKey(const Key('cash-over-reason')), findsNWidgets(2));
    });

    testWidgets('days carry their status chip; a disputed day shows the note', (
      t,
    ) async {
      await _pump(t, repo: _Fake());
      expect(_in('cash-day-2026-10-22', find.text('Pending')), findsOneWidget);
      expect(_in('cash-day-2026-10-21', find.text('Settled')), findsOneWidget);
      expect(_in('cash-day-2026-10-20', find.text('Disputed')), findsOneWidget);
      expect(
        _in(
          'cash-day-note-2026-10-20',
          find.text("Manager's note: Only 1000 reached me"),
        ),
        findsOneWidget,
      );
      expect(
        _in(
          'cash-day-2026-10-22',
          find.text('Collected ₹1,200 · Deposited ₹300'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a rider with no cash ever sees zeros, not an error', (
      t,
    ) async {
      final repo = _Fake(
        summary: CashSummary.fromJson({
          'toCollect': 0,
          'collectedToday': 0,
          'depositedToday': 0,
          'collectedTotal': 0,
          'depositedTotal': 0,
          'pending': 0,
          'submittedAwaiting': 0,
          'oldestUndepositedAt': null,
          'overLimit': false,
          'overHours': false,
          'limit': 5000,
          'maxHours': 24,
          'days': [],
        }),
      );
      await _pump(t, repo: repo);
      expect(find.text('No cash collected yet'), findsOneWidget);
      expect(find.text('Couldn\'t load this'), findsNothing);
      expect(_in('cash-pending', find.text('₹0')), findsOneWidget);
      expect(_in('tile-to-collect', find.text('₹0')), findsOneWidget);
      expect(find.text('No deposits yet.'), findsOneWidget);
      // Nothing to deposit.
      expect(
        t.widget<FilledButton>(find.byKey(const Key('deposit-cash'))).onPressed,
        isNull,
      );
    });

    testWidgets('a failed load says so and can retry', (t) async {
      final repo = _Fake()..summaryError = ApiException(503, 'migration_pending');
      await _pump(t, repo: repo);
      expect(find.text('Couldn\'t load this'), findsOneWidget);
      repo.summaryError = null;
      await _tap(t, find.text('Try again'));
      expect(_in('cash-pending', find.text('₹2,400')), findsOneWidget);
    });

    testWidgets('deposits show status and the manager note; only a waiting one '
        'can be withdrawn', (t) async {
      final repo = _Fake();
      repo.depositItems = [
        _deposit(id: 'a', amount: 600, upi: true, reference: 'UTR-1'),
        _deposit(
          id: 'b',
          amount: 400,
          status: DepositStatus.disputed,
          decisionNote: 'Only 300 reached me',
        ),
        _deposit(id: 'c', amount: 200, status: DepositStatus.confirmed),
      ];
      await _pump(t, repo: repo);
      expect(_in('deposit-a', find.text('Waiting for a manager')), findsOneWidget);
      expect(_in('deposit-a', find.text('Reference UTR-1')), findsOneWidget);
      expect(_in('deposit-b', find.text('Disputed')), findsOneWidget);
      expect(
        _in('deposit-note-b', find.text("Manager's note: Only 300 reached me")),
        findsOneWidget,
      );
      expect(_in('deposit-c', find.text('Confirmed')), findsOneWidget);
      expect(find.byKey(const Key('withdraw-a')), findsOneWidget);
      expect(find.byKey(const Key('withdraw-b')), findsNothing);
      expect(find.byKey(const Key('withdraw-c')), findsNothing);
    });

    testWidgets('withdrawing asks first, then withdraws', (t) async {
      final repo = _Fake()..depositItems = [_deposit(id: 'a')];
      await _pump(t, repo: repo);
      await _tap(t, find.byKey(const Key('withdraw-a')));
      expect(find.text('Withdraw this deposit?'), findsOneWidget);
      await _tap(t, find.byKey(const Key('withdraw-keep')));
      expect(repo.withdrawn, isEmpty);

      await _tap(t, find.byKey(const Key('withdraw-a')));
      await _tap(t, find.byKey(const Key('withdraw-confirm')));
      expect(repo.withdrawn, ['a']);
      expect(_in('deposit-a', find.text('Withdrawn')), findsOneWidget);
      expect(find.byKey(const Key('withdraw-a')), findsNothing);
    });

    testWidgets('a withdraw that lost the race says so', (t) async {
      final repo = _Fake()
        ..depositItems = [_deposit(id: 'a')]
        ..withdrawError = ApiException(409, 'already_decided');
      await _pump(t, repo: repo);
      await _tap(t, find.byKey(const Key('withdraw-a')));
      await _tap(t, find.byKey(const Key('withdraw-confirm')));
      expect(
        find.text('A manager has already looked at this deposit.'),
        findsOneWidget,
      );
    });
  });

  group('the deposit sheet', () {
    testWidgets('starts at what can be declared; a cash deposit goes through', (
      t,
    ) async {
      final repo = _Fake();
      await _pump(t, repo: repo);
      await _tap(t, find.byKey(const Key('deposit-cash')));
      expect(find.text('Deposit cash'), findsWidgets);
      expect(
        t.widget<TextField>(find.byKey(const Key('deposit-amount'))).controller!.text,
        '2400',
      );
      // Cash needs no reference.
      expect(find.byKey(const Key('deposit-reference')), findsNothing);

      await _enter(t, 'deposit-amount', '2000');
      await _enter(t, 'deposit-note', 'Handed over at the hub');
      await _tap(t, find.byKey(const Key('deposit-send')));

      expect(repo.submitted, hasLength(1));
      final sent = repo.submitted.single;
      expect(sent.amount, 2000);
      expect(sent.upi, isFalse);
      expect(sent.reference, isNull);
      expect(sent.note, 'Handed over at the hub');
      expect(sent.photo, isNull);
      // The sheet closed and the rider was told.
      expect(find.byKey(const Key('deposit-send')), findsNothing);
      expect(find.text('Sent. A manager will confirm your deposit.'), findsOneWidget);
    });

    testWidgets('what is already waiting is not offered again', (t) async {
      await _pump(t, repo: _Fake(summary: _summary(pending: 2400, awaiting: 900)));
      await _tap(t, find.byKey(const Key('deposit-cash')));
      expect(
        t.widget<TextField>(find.byKey(const Key('deposit-amount'))).controller!.text,
        '1500',
      );
    });

    testWidgets('UPI without a reference blocks the send', (t) async {
      final repo = _Fake();
      await _pump(t, repo: repo);
      await _tap(t, find.byKey(const Key('deposit-cash')));
      await _tap(t, find.text('UPI'));
      expect(find.byKey(const Key('deposit-reference')), findsOneWidget);

      await _tap(t, find.byKey(const Key('deposit-send')));
      expect(repo.submitted, isEmpty);
      expect(find.text('Enter the UPI reference for this payment.'), findsOneWidget);

      await _enter(t, 'deposit-reference', '  412345678901 ');
      await _tap(t, find.byKey(const Key('deposit-send')));
      expect(repo.submitted.single.upi, isTrue);
      expect(repo.submitted.single.reference, '412345678901');
    });

    testWidgets('more than can be declared is refused before sending', (
      t,
    ) async {
      final repo = _Fake();
      await _pump(t, repo: repo);
      await _tap(t, find.byKey(const Key('deposit-cash')));
      await _enter(t, 'deposit-amount', '2500');
      await _tap(t, find.byKey(const Key('deposit-send')));
      expect(repo.submitted, isEmpty);
      expect(find.text('You can deposit at most ₹2,400 right now.'), findsOneWidget);

      await _enter(t, 'deposit-amount', '0');
      await _tap(t, find.byKey(const Key('deposit-send')));
      expect(find.text('Enter a whole number of rupees above zero.'), findsOneWidget);
    });

    testWidgets('the server\'s exceeds_pending shows what is available', (
      t,
    ) async {
      final repo = _Fake()
        ..submitError = ApiException(
          409,
          'exceeds_pending',
          body: {'error': 'exceeds_pending', 'pending': 2400, 'available': 1800},
        );
      await _pump(t, repo: repo);
      await _tap(t, find.byKey(const Key('deposit-cash')));
      await _tap(t, find.byKey(const Key('deposit-send')));
      expect(
        _in('deposit-error', find.textContaining('at most ₹1,800')),
        findsOneWidget,
      );
      // The sheet stays open for another go.
      expect(find.byKey(const Key('deposit-send')), findsOneWidget);
    });

    testWidgets('a manager and a receipt photo travel with the deposit', (
      t,
    ) async {
      final repo = _Fake();
      final photo = _receiptFile('jpg', _jpegBytes);
      var asked = 0;
      await _pump(
        t,
        repo: repo,
        picker: ({required bool camera}) async {
          asked++;
          expect(camera, isTrue);
          return photo;
        },
      );
      await _tap(t, find.byKey(const Key('deposit-cash')));

      await _tap(t, find.byKey(const Key('deposit-manager')));
      expect(find.text('Meera Joshi').last, findsOneWidget);
      await _tap(t, find.text('Meera Joshi').last);

      await _tap(t, find.byKey(const Key('deposit-photo-camera')));
      expect(asked, 1);
      expect(find.byKey(const Key('deposit-photo-attached')), findsOneWidget);
      // The 56 dp thumbnail decodes small, not the camera's full frame.
      final thumb = t.widget<Image>(
        find.descendant(of: find.byKey(const Key('deposit-photo-attached')), matching: find.byType(Image)),
      );
      expect((thumb.image as ResizeImage).width, 168);

      await _tap(t, find.byKey(const Key('deposit-send')));
      final sent = repo.submitted.single;
      expect(sent.managerId, 'm2');
      expect(sent.photo?.path, photo.path);
      // The picked copy is not kept in the phone's cache once the sheet is gone.
      expect(photo.existsSync(), isFalse);
    });

    testWidgets('the rider can back out', (t) async {
      final repo = _Fake();
      await _pump(t, repo: repo);
      await _tap(t, find.byKey(const Key('deposit-cash')));
      await _tap(t, find.byKey(const Key('deposit-cancel')));
      expect(find.byKey(const Key('deposit-send')), findsNothing);
      expect(repo.submitted, isEmpty);
    });
  });

  group('disputes', () {
    testWidgets('a day\'s figure can be reported; the message is required', (
      t,
    ) async {
      final repo = _Fake();
      await _pump(t, repo: repo);
      await _tap(t, find.byKey(const Key('dispute-2026-10-21')));
      expect(find.byKey(const Key('dispute-day')), findsOneWidget);
      expect(find.textContaining('21 Oct 2026'), findsWidgets);

      await _tap(t, find.byKey(const Key('dispute-send')));
      expect(repo.raised, isEmpty);
      expect(find.text('Tell us what looks wrong.'), findsOneWidget);

      await _enter(t, 'dispute-message', 'One order was paid online');
      await _enter(t, 'dispute-claimed', '700');
      await _tap(t, find.byKey(const Key('dispute-send')));
      expect(repo.raised.single.day, '2026-10-21');
      expect(repo.raised.single.message, 'One order was paid online');
      expect(repo.raised.single.claimed, 700);
      expect(find.text('Report sent. A manager will check it.'), findsOneWidget);
    });

    testWidgets('a second report for the same day is explained', (t) async {
      final repo = _Fake()..disputeError = ApiException(409, 'already_open');
      await _pump(t, repo: repo);
      await _tap(t, find.byKey(const Key('dispute-2026-10-22')));
      await _enter(t, 'dispute-message', 'Wrong');
      await _tap(t, find.byKey(const Key('dispute-send')));
      expect(
        _in(
          'dispute-error',
          find.text('You have already reported a problem for this day.'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a day already reported shows it instead of the button', (
      t,
    ) async {
      final repo = _Fake()
        ..disputeItems = [
          const CashDispute(
            id: 'x1',
            day: '2026-10-22',
            message: 'Wrong total',
            open: true,
          ),
          const CashDispute(
            id: 'x2',
            day: '2026-10-19',
            message: 'Old one',
            open: false,
            resolution: 'Corrected',
          ),
        ];
      await _pump(t, repo: repo, height: 2600);
      expect(find.byKey(const Key('dispute-2026-10-22')), findsNothing);
      expect(find.byKey(const Key('reported-2026-10-22')), findsOneWidget);
      expect(find.byKey(const Key('dispute-card-x2')), findsOneWidget);
      expect(find.text('Answer: Corrected'), findsOneWidget);
    });
  });

  group('collections', () {
    testWidgets('cash beside paid-online orders, filterable', (t) async {
      final repo = _Fake()
        ..collectionItems = [
          _collection('A1', 450),
          _collection('B2', 380, online: true),
          _collection('C3', 990, status: 'not_recorded'),
        ];
      await _pump(t, repo: repo, start: '$cashPath/collections');
      expect(_in('collection-A1', find.text('Cash collected')), findsOneWidget);
      expect(_in('collection-B2', find.text('Paid online')), findsOneWidget);
      expect(_in('collection-C3', find.text('Not recorded')), findsOneWidget);
      // Paid online is never counted as cash collected.
      expect(
        find.textContaining('Cash in the orders shown: ₹450'),
        findsOneWidget,
      );
      // The last 31 days to begin with.
      expect(repo.collectionCalls.single, (from: '2026-09-22', to: '2026-10-22'));

      await _tap(t, find.byKey(const Key('show-online')));
      expect(find.byKey(const Key('collection-B2')), findsOneWidget);
      expect(find.byKey(const Key('collection-A1')), findsNothing);
      await _tap(t, find.byKey(const Key('show-cash')));
      expect(find.byKey(const Key('collection-A1')), findsOneWidget);
      expect(find.byKey(const Key('collection-B2')), findsNothing);
    });

    testWidgets('a new date range asks again', (t) async {
      final repo = _Fake();
      await _pump(t, repo: repo, start: '$cashPath/collections');
      await _tap(t, find.byKey(const Key('range-7')));
      expect(repo.collectionCalls.last, (from: '2026-10-16', to: '2026-10-22'));
      expect(find.text('No orders here'), findsOneWidget);
    });

    testWidgets('the Cash screen links to it', (t) async {
      final repo = _Fake();
      await _pump(t, repo: repo);
      await _tap(t, find.byKey(const Key('row-collections')));
      expect(find.text('Collections'), findsOneWidget);
    });
  });

  group('More and Home', () {
    testWidgets('the Cash row carries the pending amount as a badge', (t) async {
      await _pump(t, repo: _Fake(), start: '/more');
      expect(find.byKey(const Key('row-cash')), findsOneWidget);
      expect(_in('cash-badge', find.text('₹2,400')), findsOneWidget);
      await _tap(t, find.byKey(const Key('row-cash')));
      expect(find.byKey(const Key('cash-pending')), findsOneWidget);
    });

    testWidgets('no badge when nothing is held or the cash service fails', (
      t,
    ) async {
      await _pump(t, repo: _Fake(summary: _summary(pending: 0)), start: '/more');
      expect(find.byKey(const Key('row-cash')), findsOneWidget);
      expect(find.byKey(const Key('cash-badge')), findsNothing);
    });

    testWidgets('Home shows "Cash in hand" labelled Not your earnings', (
      t,
    ) async {
      await _pump(t, repo: _Fake(), start: '/home');
      expect(find.text('Cash in hand ₹2,400'), findsOneWidget);
      expect(find.text('Not your earnings'), findsOneWidget);
    });

    testWidgets('Home shows nothing when no cash is held', (t) async {
      await _pump(
        t,
        repo: _Fake(summary: _summary(pending: 0)),
        start: '/home',
      );
      expect(find.byKey(const Key('home-cash-strip')), findsNothing);
    });

    testWidgets('Home shows nothing when the cash service is down', (t) async {
      await _pump(
        t,
        repo: _Fake()..summaryError = ApiException(503, 'migration_pending'),
        start: '/home',
      );
      expect(find.byKey(const Key('home-cash-strip')), findsNothing);
    });
  });

  group('fix round 1', () {
    testWidgets('withdraw works inside the real shell (dialog context)', (
      t,
    ) async {
      final repo = _Fake()..depositItems = [_deposit(id: 'a')];
      await _pump(t, repo: repo, shell: true);
      await _tap(t, find.byKey(const Key('withdraw-a')));
      expect(find.text('Withdraw this deposit?'), findsOneWidget);

      // "Keep it" closes the dialog only; the Cash screen is still there.
      await _tap(t, find.byKey(const Key('withdraw-keep')));
      expect(find.text('Withdraw this deposit?'), findsNothing);
      expect(find.byKey(const Key('cash-pending')), findsOneWidget);
      expect(repo.withdrawn, isEmpty);

      await _tap(t, find.byKey(const Key('withdraw-a')));
      await _tap(t, find.byKey(const Key('withdraw-confirm')));
      expect(find.text('Withdraw this deposit?'), findsNothing);
      expect(find.byKey(const Key('cash-pending')), findsOneWidget);
      expect(repo.withdrawn, ['a']);
    });

    testWidgets('a later deposit does not inherit a finished withdraw busy flag', (
      t,
    ) async {
      final repo = _Fake()
        ..depositItems = [_deposit(id: 'a'), _deposit(id: 'b', amount: 100)];
      await _pump(t, repo: repo);
      await _tap(t, find.byKey(const Key('withdraw-a')));
      await _tap(t, find.byKey(const Key('withdraw-confirm')));
      expect(repo.withdrawn, ['a']);
      // b is still waiting and its Withdraw is live.
      expect(
        t.widget<TextButton>(find.byKey(const Key('withdraw-b'))).onPressed,
        isNotNull,
      );
    });

    testWidgets('an unknown deposit status is "Under review" with no action', (
      t,
    ) async {
      final repo = _Fake()
        ..depositItems = [
          CashDeposit.fromJson({
            'id': 'u',
            'amount': 300,
            'method': 'cash',
            'status': 'reopened',
            'createdAt': '2026-10-22T01:00:00.000Z',
          }),
        ];
      await _pump(t, repo: repo);
      expect(_in('deposit-u', find.text('Under review')), findsOneWidget);
      expect(find.byKey(const Key('withdraw-u')), findsNothing);
    });

    testWidgets('a photo that is not a JPEG or PNG is refused on the spot', (
      t,
    ) async {
      final repo = _Fake();
      final bad = _receiptFile('jpg', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      await _pump(
        t,
        repo: repo,
        picker: ({required bool camera}) async => bad,
      );
      await _tap(t, find.byKey(const Key('deposit-cash')));
      await _tap(t, find.byKey(const Key('deposit-photo-gallery')));
      expect(find.byKey(const Key('deposit-photo-attached')), findsNothing);
      expect(
        _in('deposit-photo-error', find.textContaining("can't be used")),
        findsOneWidget,
      );
      expect(bad.existsSync(), isFalse);
      await _tap(t, find.byKey(const Key('deposit-send')));
      expect(repo.submitted.single.photo, isNull);
    });

    testWidgets('a photo over 4 MB is refused', (t) async {
      final big = _receiptFile('jpg', _jpegBytes, pad: receiptMaxBytes);
      await _pump(
        t,
        repo: _Fake(),
        picker: ({required bool camera}) async => big,
      );
      await _tap(t, find.byKey(const Key('deposit-cash')));
      await _tap(t, find.byKey(const Key('deposit-photo-camera')));
      expect(find.byKey(const Key('deposit-photo-attached')), findsNothing);
      expect(find.byKey(const Key('deposit-photo-error')), findsOneWidget);
    });

    testWidgets('a refused camera permission says what to do', (t) async {
      await _pump(
        t,
        repo: _Fake(),
        picker: ({required bool camera}) async =>
            throw PlatformException(code: 'camera_access_denied'),
      );
      await _tap(t, find.byKey(const Key('deposit-cash')));
      await _tap(t, find.byKey(const Key('deposit-photo-camera')));
      expect(
        find.text('Allow camera access in Settings to add a photo.'),
        findsOneWidget,
      );
    });

    testWidgets('a deposit being sent cannot be closed or have its photo changed', (
      t,
    ) async {
      final gate = Completer<void>();
      final repo = _GatedFake(gate);
      final photo = _receiptFile('png', _pngBytes);
      await _pump(
        t,
        repo: repo,
        picker: ({required bool camera}) async => photo,
      );
      await _tap(t, find.byKey(const Key('deposit-cash')));
      await _tap(t, find.byKey(const Key('deposit-photo-gallery')));
      await _tap(t, find.byKey(const Key('deposit-send')));

      // Sending: Android back does not close the sheet, nor does Cancel.
      await t.binding.handlePopRoute();
      await _settle(t);
      expect(find.byKey(const Key('deposit-send')), findsOneWidget);
      expect(
        t.widget<OutlinedButton>(find.byKey(const Key('deposit-cancel'))).onPressed,
        isNull,
      );
      expect(
        t.widget<TextButton>(find.byKey(const Key('deposit-photo-remove'))).onPressed,
        isNull,
      );

      gate.complete();
      await _settle(t);
      expect(find.byKey(const Key('deposit-send')), findsNothing);
    });

    testWidgets('the summary starts over for a different rider', (t) async {
      final repo = _Fake();
      final c = await _pump(t, repo: repo);
      await c.read(cashSummaryProvider(c.read(riderKeyProvider)).future);
      expect(c.read(cashSummaryProvider(c.read(riderKeyProvider))).value?.pending, 2400);

      repo.summaryValue = _summary(pending: 77);
      c.read(_uidProvider.notifier).set('rider-2');
      await _settle(t);
      expect(c.read(cashSummaryProvider(c.read(riderKeyProvider))).value?.pending, 77);
    });

    testWidgets('it is read again when the delivery moves', (t) async {
      final repo = _Fake();
      final c = await _pump(t, repo: repo);
      await c.read(cashSummaryProvider(c.read(riderKeyProvider)).future);

      repo.summaryValue = _summary(pending: 2850);
      (c.read(boardProvider.notifier) as _StubBoard).carry(_active('accepted'));
      await _settle(t);
      expect(c.read(cashSummaryProvider(c.read(riderKeyProvider))).value?.pending, 2850);

      repo.summaryValue = _summary(pending: 3300);
      (c.read(boardProvider.notifier) as _StubBoard).carry(_active('picked_up'));
      await _settle(t);
      expect(c.read(cashSummaryProvider(c.read(riderKeyProvider))).value?.pending, 3300);
    });

    testWidgets('it is read again when a deliver step is answered', (t) async {
      final repo = _Fake();
      final c = await _pump(t, repo: repo);
      await c.read(cashSummaryProvider(c.read(riderKeyProvider)).future);

      repo.summaryValue = _summary(pending: 2850);
      // A step other than deliver changes nothing here.
      await t.runAsync(
        () => c.read(actionQueueProvider).submit(
          QueuedAction(
            actionId: 'a1',
            orderId: 'order-1',
            action: 'pickup',
            queuedAt: DateTime.utc(2026, 10, 22, 3),
          ),
        ),
      );
      await _settle(t);
      expect(c.read(cashSummaryProvider(c.read(riderKeyProvider))).value?.pending, 2400);

      await t.runAsync(
        () => c.read(actionQueueProvider).submit(
          QueuedAction(
            actionId: 'a2',
            orderId: 'order-1',
            action: 'deliver',
            queuedAt: DateTime.utc(2026, 10, 22, 3),
          ),
        ),
      );
      await _settle(t);
      expect(c.read(cashSummaryProvider(c.read(riderKeyProvider))).value?.pending, 2850);
    });

    test("a receipt's type comes from its bytes, not its name", () {
      expect(sniffReceiptType(_jpegBytes)?.subtype, 'jpeg');
      expect(sniffReceiptType(_pngBytes)?.subtype, 'png');
      expect(sniffReceiptType([0x47, 0x49, 0x46]), isNull);
      expect(sniffReceiptType([]), isNull);
      expect(sniffReceiptType([0x25, 0x50, 0x44, 0x46, 0x2D]), isNull, reason: 'a PDF is not a receipt photo');
      // A JPEG named .png is a JPEG; a PNG named .jpg is a PNG.
      expect(receiptTypeOf(_receiptFile('png', _jpegBytes))?.subtype, 'jpeg');
      expect(receiptTypeOf(_receiptFile('jpg', _pngBytes))?.subtype, 'png');
      expect(receiptTypeOf(_receiptFile('jpg', [])), isNull);
      expect(
        receiptTypeOf(_receiptFile('jpg', _jpegBytes, pad: receiptMaxBytes)),
        isNull,
      );
    });

    test('the upload declares the sniffed type and refuses a bad photo', () async {
      final seen = <http.Request>[];
      final supabase = SupabaseClient(
        'https://example.supabase.co',
        'anon',
        authOptions: const AuthClientOptions(autoRefreshToken: false),
        httpClient: MockClient((_) async => http.Response('{}', 200)),
      );
      addTearDown(() => unawaited(supabase.dispose()));
      final api = ApiClient(
        supabase.auth,
        client: MockClient((req) async {
          seen.add(req);
          return http.Response(
            '{"ok":true,"id":"dep-1"}',
            201,
            headers: {'content-type': 'application/json'},
          );
        }),
      );
      final repo = ApiCashRepository(api);

      // A JPEG with a .png name goes as image/jpeg.
      final id = await repo.submitDeposit(
        amount: 500,
        upi: false,
        photo: _receiptFile('png', _jpegBytes),
      );
      expect(id, 'dep-1');
      final body = latin1.decode(seen.single.bodyBytes);
      expect(body, contains('content-type: image/jpeg'));
      expect(body, contains('name="photo"'));
      expect(body, contains('filename="receipt.jpg"'));

      await expectLater(
        repo.submitDeposit(
          amount: 500,
          upi: false,
          photo: _receiptFile('jpg', [0x47, 0x49, 0x46, 0x38]),
        ),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'bad_photo')),
      );
      expect(seen, hasLength(1));

      // No photo: the same fields go as JSON, the amount a number.
      await repo.submitDeposit(amount: 750, upi: true, reference: ' UTR1 ');
      final json = seen.last;
      expect(json.headers['content-type'], contains('application/json'));
      expect(jsonDecode(json.body), {'amount': 750, 'method': 'upi', 'reference': 'UTR1'});
    });
  });

  group('looks', () {
    for (final brightness in Brightness.values) {
      testWidgets('${brightness.name} at 1.3x text, over the limit', (t) async {
        await _pump(
          t,
          repo: _Fake(
            summary: _summary(
              pending: 123456,
              toCollect: 98765,
              overLimit: true,
              overHours: true,
            ),
          )..depositItems = [_deposit(id: 'a', amount: 123456)],
          brightness: brightness,
          textScale: 1.3,
        );
        expect(find.byKey(const Key('cash-pending')), findsOneWidget);
        expect(t.takeException(), isNull);
        await _tap(t, find.byKey(const Key('deposit-cash')));
        expect(find.byKey(const Key('deposit-send')), findsOneWidget);
        expect(t.takeException(), isNull);
      });
    }
  });
}
