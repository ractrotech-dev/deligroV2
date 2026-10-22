// Fixture earnings for the debug-only preview. Imported only from
// state/earnings.dart behind `fixturesEnabled`, which is a compile-time false
// in a release build, so none of this is in the release app.
import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/money.dart';
import '../../models/earnings.dart';
import '../earnings_repository.dart';

/// Which rider a fixture session is (`--dart-define=FIXTURE_EARNINGS=`): `paid`
/// (money owed and a payout made), `owing` (pending is negative), `empty`
/// (a rider who has not delivered yet) or `off` (every call fails as the
/// server does with `driver.earnings` off).
const String fixtureEarningsScenario = String.fromEnvironment(
  'FIXTURE_EARNINGS',
  defaultValue: 'paid',
);

/// The payout reference every fixture payout carries; unique, so a release
/// build can be searched for it to prove the fixtures are not in it.
const fixtureEarningsReference = 'FXT-UTR-90417';

/// [EarningsRepository] over in-memory records whose totals are worked out
/// from the records themselves, the way the server does, so the screens and
/// the statement always agree.
class FixtureEarningsRepository implements EarningsRepository {
  FixtureEarningsRepository._(this._scenario, this._today) {
    _build();
  }

  factory FixtureEarningsRepository.create({
    String scenario = fixtureEarningsScenario,
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
    return FixtureEarningsRepository._(
      scenario,
      istDayKey(now ?? DateTime.now()),
    );
  }

  final String _scenario;
  final String _today;
  final _records = <Map<String, dynamic>>[];
  final _payouts = <Map<String, dynamic>>[];
  final _incentives = <Map<String, dynamic>>[];

  String _day(int ago) => addDays(_today, -ago);

  Map<String, dynamic> _delivery(
    String id,
    int ago, {
    required double amount,
    String? code,
    double base = 20,
    double km = 3.4,
    String? source = 'road',
    double distanceFee = 12,
    double topup = 0,
    double tip = 0,
    bool tipInCash = false,
    String? payout,
    bool reversed = false,
  }) => {
    'kind': 'delivery',
    'id': id,
    'orderId': 'order-$id',
    'orderCode':
        code ?? '#${id.toUpperCase().padRight(6, '0').substring(0, 6)}',
    'date': _day(ago),
    'baseFee': base,
    'distanceKm': source == null ? 0 : km,
    'distanceSource': source,
    'distanceFee': distanceFee,
    'minTopup': topup,
    'tip': tip,
    'tipInCash': tipInCash,
    'incentive': null,
    'deduction': null,
    'amount': amount,
    'status': payout == null ? 'pending' : 'paid',
    'settledOn': payout == null ? null : _day(payout == 'p0' ? 14 : 3),
    'reference': payout == null ? null : fixtureEarningsReference,
    'note': null,
    'reversed': reversed,
    'reversesId': null,
    '_payout': payout,
  };

  Map<String, dynamic> _other(
    String kind,
    String id,
    int ago, {
    required double amount,
    String? note,
    String? code,
    String? reverses,
    double? deduction,
    double? incentive,
    String? payout,
  }) => {
    'kind': kind,
    'id': id,
    'orderId': code == null ? null : 'order-$id',
    'orderCode': code,
    'date': _day(ago),
    'baseFee': null,
    'distanceKm': null,
    'distanceSource': null,
    'distanceFee': null,
    'minTopup': null,
    'tip': null,
    'tipInCash': null,
    'incentive': incentive,
    'deduction': deduction,
    'amount': amount,
    'status': payout == null ? 'pending' : 'paid',
    'settledOn': payout == null ? null : _day(payout == 'p0' ? 20 : 50),
    'reference': payout == null
        ? null
        : (payout == 'p0' ? fixtureEarningsReference : 'FXT-UPI-5521'),
    'note': note,
    'reversed': false,
    'reversesId': reverses,
    '_payout': payout,
  };

  void _build() {
    if (_scenario == 'empty') return;

    // Riders are on a salary (ruling P3-R11): a delivery's earning row is ₹0
    // and only counts towards incentive targets, so the app lists none of them.
    for (var i = 0; i < 14; i++) {
      _records.add(
        _delivery(
          'z$i',
          i ~/ 2,
          amount: 0,
          base: 0,
          distanceFee: 0,
          code: '#Z${(4100 + i * 7).toString().padLeft(5, '0')}',
        ),
      );
    }

    // Last month's salary, a bonus and a deduction, settled by one bank payout.
    _records.addAll([
      _other(
        'salary',
        's0',
        25,
        amount: 18000,
        note: 'September salary',
        payout: 'p0',
      ),
      _other(
        'bonus',
        'b0',
        24,
        amount: 1500,
        note: 'Diwali bonus',
        payout: 'p0',
      ),
      _other(
        'deduction',
        'x0',
        22,
        amount: -300,
        note: 'Uniform',
        deduction: 300,
        payout: 'p0',
      ),
    ]);
    _payouts.add({
      'id': 'p0',
      'amount': 19200,
      'method': 'bank',
      'reference': fixtureEarningsReference,
      'paidOn': _day(20),
      'periodEnd': _day(22),
      'items': 3,
    });
    // An older one, paid by UPI.
    _records.addAll([
      _other(
        'salary',
        's00',
        56,
        amount: 18000,
        note: 'August salary',
        payout: 'p00',
      ),
    ]);
    _payouts.add({
      'id': 'p00',
      'amount': 18000,
      'method': 'upi',
      'reference': 'FXT-UPI-5521',
      'paidOn': _day(50),
      'periodEnd': _day(56),
      'items': 1,
    });

    // This month, not yet paid.
    _records.addAll([
      _other('salary', 's1', 3, amount: 18000, note: 'October salary'),
      _other('adjustment', 'a1', 5, amount: 150, note: 'Fuel allowance'),
      _other(
        'deduction',
        'x1',
        4,
        amount: -20,
        note: 'Late fee',
        code: '#Z04121',
        deduction: 20,
      ),
      _other('bonus', 'b1', 2, amount: 500, note: 'Festival bonus'),
      _other(
        'incentive',
        'i1',
        1,
        amount: 100,
        note: 'Evening rush',
        code: '#Z04135',
        incentive: 100,
      ),
    ]);

    if (_scenario == 'owing') {
      // A deduction big enough that everything unpaid is outweighed: pending -120.
      final owed = _pending();
      _records.add(
        _other(
          'deduction',
          'x2',
          0,
          amount: -(owed + 120),
          note: 'Damaged bag',
          deduction: owed + 120,
        ),
      );
    }

    _incentives.addAll([
      {
        'ruleId': 'rule-1',
        'name': 'Evening rush',
        'period': 'daily',
        'target': 10,
        'done': 7,
        'bonus': 100,
        'window': '18:00–22:00',
        'endsOn': _day(-9),
        'earned': false,
      },
      {
        'ruleId': 'rule-2',
        'name': 'Weekly warrior',
        'period': 'weekly',
        'target': 40,
        'done': 40,
        'bonus': 500,
        'window': null,
        'endsOn': null,
        'earned': true,
      },
      {
        'ruleId': 'rule-3',
        'name': 'Lunch hour',
        'period': 'daily',
        'target': 3,
        'done': 1,
        'bonus': 30.5,
        'window': '12:00–15:00',
        'endsOn': _day(-2),
        'earned': false,
      },
    ]);
  }

  // -------------------------------------------------------------------------
  // the arithmetic, from the records
  // -------------------------------------------------------------------------

  double _sum(Iterable<Map<String, dynamic>> rows) {
    var paise = 0;
    for (final r in rows) {
      paise += ((r['amount'] as num) * 100).round();
    }
    return paise / 100;
  }

  double _pending() => _sum(
    _records.where((r) => r['_payout'] == null && r['status'] == 'pending'),
  );

  /// Every ledger entry counts (salary, bonuses, incentives, adjustments less
  /// deductions) except a delivery that was reversed.
  bool _isPerformance(Map<String, dynamic> r) => r['reversed'] != true;

  EarningRecord _record(Map<String, dynamic> j) => EarningRecord.fromJson(j);

  String _weekStart() {
    final d = parseDay(_today)!;
    return addDays(_today, -((d.weekday + 6) % 7));
  }

  @override
  Future<EarningsSummary> summary() async {
    _requireOn();
    double since(String from) => _sum(
      _records.where(
        (r) => _isPerformance(r) && (r['date'] as String).compareTo(from) >= 0,
      ),
    );
    final live = _records
        .where((r) => r['kind'] == 'delivery' && r['reversed'] != true)
        .toList();
    final paid = _payouts.fold<double>(0, (a, p) => a + (p['amount'] as num));
    final latest = _payouts.isEmpty
        ? null
        : (List.of(_payouts)..sort(
                (a, b) =>
                    (b['paidOn'] as String).compareTo(a['paidOn'] as String),
              ))
              .first;
    return EarningsSummary.fromJson({
      'today': since(_today),
      'week': since(_weekStart()),
      'month': since('${_today.substring(0, 8)}01'),
      'total': since('0000-00-00'),
      'perDeliveryAvg': null,
      'deliveriesCounted': live.length,
      'incentives': _sum(_records.where((r) => r['kind'] == 'incentive')),
      'bonuses': _sum(_records.where((r) => r['kind'] == 'bonus')),
      'adjustments': _sum(
        _records.where(
          (r) => r['kind'] == 'adjustment' && r['reversesId'] == null,
        ),
      ),
      'deductions': -_sum(_records.where((r) => r['kind'] == 'deduction')),
      'salary': _sum(_records.where((r) => r['kind'] == 'salary')),
      'paid': paid,
      'pending': _pending(),
      'lastPayout': latest == null
          ? null
          : {
              'amount': latest['amount'],
              'paidOn': latest['paidOn'],
              'reference': latest['reference'],
            },
    });
  }

  List<Map<String, dynamic>> _inRange(String from, String to) => _records
      .where(
        (r) =>
            (r['date'] as String).compareTo(from) >= 0 &&
            (r['date'] as String).compareTo(to) <= 0,
      )
      .toList();

  static const _order = {
    'delivery': 0,
    'incentive': 1,
    'bonus': 2,
    'salary': 3,
    'adjustment': 4,
    'deduction': 5,
  };

  int _newestFirst(Map<String, dynamic> a, Map<String, dynamic> b) {
    final byDate = (b['date'] as String).compareTo(a['date'] as String);
    if (byDate != 0) return byDate;
    final byKind = _order[a['kind']]!.compareTo(_order[b['kind']]!);
    return byKind != 0
        ? byKind
        : (a['id'] as String).compareTo(b['id'] as String);
  }

  @override
  Future<RecordsPage> records({
    required String from,
    required String to,
    String? cursor,
    int limit = 50,
  }) async {
    _requireOn();
    final rows = _inRange(from, to)..sort(_newestFirst);
    final start = int.tryParse(cursor ?? '') ?? 0;
    final page = rows.skip(start).take(limit).toList();
    final next = start + page.length;
    return RecordsPage(
      items: [for (final r in page) _record(r)],
      nextCursor: next < rows.length ? '$next' : null,
    );
  }

  @override
  Future<List<Payout>> payouts() async {
    _requireOn();
    final sorted = List.of(
      _payouts,
    )..sort((a, b) => (b['paidOn'] as String).compareTo(a['paidOn'] as String));
    return [for (final p in sorted) Payout.fromJson(p)];
  }

  @override
  Future<List<IncentiveProgress>> incentives() async {
    _requireOn();
    return [for (final i in _incentives) IncentiveProgress.fromJson(i)];
  }

  @override
  Future<Statement> statement(String from, String to) async {
    _requireOn();
    final span = parseDay(to)!.difference(parseDay(from)!).inDays;
    if (span < 0 || span + 1 > 366) throw ApiException(400, 'invalid_range');
    bool before(Map<String, dynamic> r) =>
        (r['date'] as String).compareTo(from) < 0;
    final opening =
        _sum(_records.where(before)) -
        _payouts
            .where((p) => (p['paidOn'] as String).compareTo(from) < 0)
            .fold<double>(0, (a, p) => a + (p['amount'] as num));
    final rows = _inRange(from, to)..sort((a, b) => -_newestFirst(a, b));
    final earned = _sum(rows);
    final paid = _payouts
        .where(
          (p) =>
              (p['paidOn'] as String).compareTo(from) >= 0 &&
              (p['paidOn'] as String).compareTo(to) <= 0,
        )
        .fold<double>(0, (a, p) => a + (p['amount'] as num));
    return Statement.fromJson({
      'riderCode': 'DR-0042',
      'name': 'Ravi Kumar',
      'from': from,
      'to': to,
      'openingPending': opening,
      'earned': earned,
      'paid': paid,
      'closingPending': opening + earned - paid,
      'rows': rows,
    });
  }

  void _requireOn() {
    if (_scenario == 'off') throw ApiException(403, 'feature_disabled');
  }
}
