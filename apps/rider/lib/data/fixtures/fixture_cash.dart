// Fixture cash for the debug-only preview. Imported only from state/cash.dart
// behind `fixturesEnabled`, which is a compile-time false in a release build,
// so none of this is in the release app.
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/money.dart';
import '../../models/cash.dart';
import '../cash_repository.dart';

/// Which rider a fixture session is (`--dart-define=FIXTURE_CASH=`): `holding`
/// (over the limit, a disputed day, deposits in every state), `fine` (a little
/// cash, under the limit), `empty` (never collected cash) or `off` (every call
/// fails as the server does without migration 0085).
const String fixtureCashScenario = String.fromEnvironment(
  'FIXTURE_CASH',
  defaultValue: 'holding',
);

/// The UPI reference the fixture deposit carries; unique, so a release build
/// can be searched for it to prove the fixtures are not in it.
const fixtureCashReference = 'FXT-UPI-5521';

/// [CashRepository] over in-memory records. Declaring a deposit, withdrawing
/// one and raising a dispute change what the next read says, as the server
/// would.
class FixtureCashRepository implements CashRepository {
  FixtureCashRepository._(this._scenario, this._now) {
    _build();
  }

  factory FixtureCashRepository.create({
    String scenario = fixtureCashScenario,
    DateTime? now,
    @visibleForTesting bool releaseMode = kReleaseMode,
  }) {
    assert(
      !kReleaseMode,
      'the fixture backend must never be built in a release build',
    );
    if (releaseMode) {
      throw StateError(
        'the fixture backend is not available in a release build',
      );
    }
    return FixtureCashRepository._(scenario, now ?? DateTime.now());
  }

  final String _scenario;
  final DateTime _now;
  var _serial = 0;

  late int _pending;
  late int _toCollect;
  late int _collectedToday;
  late int _depositedToday;
  late int _limit;
  late List<CashDay> _days;
  final _deposits = <CashDeposit>[];
  final _disputes = <CashDispute>[];
  final _collections = <CashCollection>[];

  String _today() => istDayKey(_now);

  void _build() {
    final today = _today();
    String day(int ago) => addDays(today, -ago);
    DateTime at(int daysAgo, int hour) =>
        DateTime(_now.year, _now.month, _now.day - daysAgo, hour, 15);

    switch (_scenario) {
      case 'empty':
        _pending = 0;
        _toCollect = 0;
        _collectedToday = 0;
        _depositedToday = 0;
        _limit = 5000;
        _days = [];
      case 'fine':
        _pending = 850;
        _toCollect = 300;
        _collectedToday = 850;
        _depositedToday = 0;
        _limit = 5000;
        _days = [
          CashDay(
            day: day(0),
            collected: 850,
            deposited: 0,
            status: DayStatus.pending,
          ),
          CashDay(
            day: day(1),
            collected: 1200,
            deposited: 1200,
            status: DayStatus.settled,
          ),
        ];
      default:
        _pending = 5400;
        _toCollect = 450;
        _collectedToday = 1200;
        _depositedToday = 0;
        _limit = 5000;
        _days = [
          CashDay(
            day: day(0),
            collected: 1200,
            deposited: 0,
            status: DayStatus.pending,
          ),
          CashDay(
            day: day(1),
            collected: 2100,
            deposited: 0,
            status: DayStatus.disputed,
            note: 'Only ₹1,600 reached me. Please recount.',
          ),
          CashDay(
            day: day(2),
            collected: 2100,
            deposited: 1500,
            status: DayStatus.pending,
          ),
          CashDay(
            day: day(3),
            collected: 1800,
            deposited: 1800,
            status: DayStatus.settled,
          ),
        ];
        _deposits.addAll([
          CashDeposit(
            id: 'fx-dep-1',
            amount: 1000,
            upi: true,
            status: DepositStatus.submitted,
            createdAt: at(0, 9),
            managerName: 'Anil Verma',
            reference: fixtureCashReference,
            hasReceipt: true,
            note: 'Sent to the shop account',
          ),
          CashDeposit(
            id: 'fx-dep-2',
            amount: 2000,
            upi: false,
            status: DepositStatus.disputed,
            createdAt: at(1, 19),
            managerName: 'Anil Verma',
            decisionNote: 'Only ₹1,600 reached me. Please recount.',
          ),
          CashDeposit(
            id: 'fx-dep-3',
            amount: 1500,
            upi: false,
            status: DepositStatus.confirmed,
            createdAt: at(2, 20),
            managerName: 'Meera Joshi',
          ),
        ]);
        _disputes.add(
          CashDispute(
            id: 'fx-dis-1',
            day: day(5),
            message: 'One order was paid online but counted as cash.',
            open: false,
            claimedAmount: 1900,
            resolution: 'Corrected. The order is now marked as paid online.',
          ),
        );
    }

    if (_scenario != 'empty') {
      final rows = <(int, int, int, String, int, bool, String)>[
        // daysAgo, hour, index, code, amount, online, status
        (0, 13, 1, 'A1B2C3D4', 450, false, 'collected'),
        (0, 12, 2, 'B7C8D9E0', 380, true, 'paid_online'),
        (0, 10, 3, 'C1D2E3F4', 370, false, 'collected'),
        (1, 20, 4, 'D5E6F7A8', 520, false, 'collected'),
        (1, 18, 5, 'E9F0A1B2', 610, true, 'paid_online'),
        (1, 14, 6, 'F3A4B5C6', 990, false, 'not_recorded'),
        (2, 19, 7, 'A7B8C9D0', 640, false, 'collected'),
        (3, 13, 8, 'B1C2D3E4', 1800, false, 'collected'),
      ];
      for (final r in rows) {
        _collections.add(
          CashCollection(
            orderId: 'fx-order-${r.$3}',
            code: '#${r.$4}',
            at: at(r.$1, r.$2),
            amount: r.$5,
            online: r.$6,
            status: r.$7,
          ),
        );
      }
    }
  }

  void _guard() {
    if (_scenario == 'off') throw ApiException(503, 'migration_pending');
  }

  int get _awaiting => _deposits
      .where((d) => d.status == DepositStatus.submitted)
      .fold(0, (a, d) => a + d.amount);

  @override
  Future<CashSummary> summary() async {
    _guard();
    final days = [
      for (final d in _days)
        if (_disputes.any((x) => x.open && x.day == d.day))
          CashDay(
            day: d.day,
            collected: d.collected,
            deposited: d.deposited,
            status: DayStatus.disputed,
            note: d.note,
          )
        else
          d,
    ];
    return CashSummary(
      toCollect: _toCollect,
      collectedToday: _collectedToday,
      depositedToday: _depositedToday,
      collectedTotal: _pending + 3300,
      depositedTotal: _pending == 0 ? 0 : 3300,
      pending: _pending,
      submittedAwaiting: _awaiting,
      oldestUndepositedAt: _pending > 0
          ? _now.subtract(const Duration(hours: 52))
          : null,
      overLimit: _pending > _limit,
      overHours: _pending > _limit,
      limit: _limit,
      maxHours: 24,
      days: days,
    );
  }

  @override
  Future<CollectionsPage> collections({
    required String from,
    required String to,
    String? cursor,
    int limit = 50,
  }) async {
    _guard();
    final items = _collections.where((c) {
      final d = istDayKey(c.at);
      return d.compareTo(from) >= 0 && d.compareTo(to) <= 0;
    }).toList();
    return CollectionsPage(items: items);
  }

  @override
  Future<List<CashDeposit>> deposits() async {
    _guard();
    return List.of(_deposits);
  }

  @override
  Future<List<CashManager>> managers() async {
    _guard();
    return const [
      CashManager(id: 'fx-mgr-1', name: 'Anil Verma'),
      CashManager(id: 'fx-mgr-2', name: 'Meera Joshi'),
    ];
  }

  @override
  Future<String> submitDeposit({
    required int amount,
    required bool upi,
    String? managerId,
    String? reference,
    String? note,
    File? photo,
  }) async {
    _guard();
    final available = (_pending - _awaiting).clamp(0, _pending);
    if (amount > available) {
      throw ApiException(
        409,
        'exceeds_pending',
        body: {'error': 'exceeds_pending', 'pending': _pending, 'available': available},
      );
    }
    final id = 'fx-dep-new-${++_serial}';
    final manager = (await managers())
        .where((m) => m.id == managerId)
        .map((m) => m.name)
        .firstOrNull;
    _deposits.insert(
      0,
      CashDeposit(
        id: id,
        amount: amount,
        upi: upi,
        status: DepositStatus.submitted,
        createdAt: _now,
        managerName: manager,
        reference: upi ? reference : null,
        note: note,
        hasReceipt: photo != null,
      ),
    );
    return id;
  }

  @override
  Future<void> withdrawDeposit(String id) async {
    _guard();
    final i = _deposits.indexWhere((d) => d.id == id);
    if (i < 0) throw ApiException(404, 'not_found');
    final d = _deposits[i];
    if (d.status != DepositStatus.submitted) {
      throw ApiException(409, 'already_decided');
    }
    _deposits[i] = CashDeposit(
      id: d.id,
      amount: d.amount,
      upi: d.upi,
      status: DepositStatus.withdrawn,
      createdAt: d.createdAt,
      managerName: d.managerName,
      reference: d.reference,
      note: d.note,
      hasReceipt: d.hasReceipt,
    );
  }

  @override
  Future<List<CashDispute>> disputes() async {
    _guard();
    return List.of(_disputes);
  }

  @override
  Future<String> raiseDispute({
    required String day,
    required String message,
    int? claimedAmount,
  }) async {
    _guard();
    if (_disputes.any((d) => d.open && d.day == day)) {
      throw ApiException(409, 'already_open');
    }
    final id = 'fx-dis-new-${++_serial}';
    _disputes.insert(
      0,
      CashDispute(
        id: id,
        day: day,
        message: message,
        open: true,
        claimedAmount: claimedAmount,
      ),
    );
    return id;
  }
}
