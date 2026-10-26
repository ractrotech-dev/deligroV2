// Fake repositories for the text-scale test: the fixture backends' realistic
// data, with the strings that grow in real life (names, shops, addresses,
// notes, ticket text, error words) made as long as a real rider's can be, and
// every read able to fail or come back empty on demand. No network.
import 'dart:io';

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/money.dart';
import 'package:deligro_rider/data/cash_repository.dart';
import 'package:deligro_rider/data/earnings_repository.dart';
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/data/fixtures/fixture_cash.dart';
import 'package:deligro_rider/data/fixtures/fixture_earnings.dart';
import 'package:deligro_rider/data/fixtures/fixture_insights.dart';
import 'package:deligro_rider/data/fixtures/fixture_profile.dart';
import 'package:deligro_rider/data/fixtures/fixture_support.dart';
import 'package:deligro_rider/data/insights_repository.dart';
import 'package:deligro_rider/data/jobs_repository.dart';
import 'package:deligro_rider/data/notifications_repository.dart';
import 'package:deligro_rider/data/profile_repository.dart';
import 'package:deligro_rider/data/safety_repository.dart';
import 'package:deligro_rider/data/support_repository.dart';
import 'package:deligro_rider/core/document_file.dart';
import 'package:deligro_rider/models/cash.dart';
import 'package:deligro_rider/models/dashboard.dart';
import 'package:deligro_rider/models/earnings.dart';
import 'package:deligro_rider/models/inbox.dart';
import 'package:deligro_rider/models/insights.dart';
import 'package:deligro_rider/models/jobs.dart';
import 'package:deligro_rider/models/profile.dart';
import 'package:deligro_rider/models/queued_action.dart';
import 'package:deligro_rider/models/support.dart';

// ---------------------------------------------------------------------------
// The long words
// ---------------------------------------------------------------------------

const longRider = 'Venkatanarasimha Rajuvaripet Subrahmanyam Chandrasekhar';
const longShop = 'Shree Ganesh Mishthan Bhandar and Family Restaurant (Pure Veg)';
const longShopLine = 'Shop 14, Ground Floor, Near Old Bus Stand, Main Market Road, Bemetara 491335';
const longDropLine =
    'House 221/B, Behind Government Higher Secondary School, Ward 17, Gandhi Nagar Colony, Bemetara 491335';
const longCustomer = 'Anitha Lakshmi Venkataraman-Iyer';
const longInstructions =
    'Please call when you reach the main gate. The building has no lift, so come up to the third floor and ring the bell twice.';
const longItem = 'Paneer butter masala with extra butter and two tandoori rotis (family pack)';
const longReason =
    'Customer did not answer after three calls and the security guard would not let me inside the society gate';
const longNote =
    'Called the customer three times and waited twenty minutes at the gate. The guard says nobody is home today.';
const longArea = 'Gandhi Nagar Colony, Behind Government Higher Secondary School';
const longManager = 'Bhagyalakshmi Ramachandran-Krishnamurthy';
const longRelation = 'Elder brother-in-law (lives nearby)';
const longTicket =
    'The customer paid ₹1,250 in cash but the app shows ₹1,520 to collect, and the shop says the bill was changed after pickup';

/// A refusal whose words are among the longest the app has: what a rider
/// with expired documents is told when they try to take a job.
ApiException longError() => ApiException(409, 'documents_expired');

/// A dead connection: what most screens show when they cannot load.
ApiException networkError() => ApiException(0, 'network');

String _iso(DateTime t) => t.toUtc().toIso8601String();

/// What every fake reads to decide how to answer.
class ScaleWorld {
  /// Long strings everywhere they can be long.
  bool long = true;

  /// Every read fails.
  bool fail = false;

  /// Every list is empty (a brand-new rider).
  bool empty = false;

  /// The jobs board scenario ([FixtureData.scenarios]).
  String board = 'offers';

  /// Deligro has approved two of the rider's requests (shown on the card), and
  /// the delivery needs no proof photo: "Delivered" is live from the start.
  bool approvals = false;

  /// The rider has no emergency contact saved.
  bool noContact = false;

  /// An SOS alert cannot reach the server (it waits in the queue).
  bool sosOffline = false;

  DateTime now = DateTime.now();

  void check() {
    if (fail) throw longError();
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

Object? _lengthen(Object? v, String? key) {
  if (v is Map) {
    final isItem = v.containsKey('qty');
    return {
      for (final e in v.entries)
        '${e.key}': switch ('${e.key}') {
          'name' when e.value is String => isItem ? longItem : longShop,
          'line' when e.value is String => key == 'drop' ? longDropLine : longShopLine,
          'customerName' when e.value is String => longCustomer,
          'instructions' when e.value is String => longInstructions,
          'reason' when e.value is String => longReason,
          'decisionNote' when e.value is String => longNote,
          _ => _lengthen(e.value, '${e.key}'),
        },
    };
  }
  if (v is List) return [for (final x in v) _lengthen(x, key)];
  return v;
}

class ScaleJobs implements JobsRepository {
  ScaleJobs(this.w) : _inner = FixtureJobsRepository.create(scenario: w.board, now: w.now);

  final ScaleWorld w;
  final FixtureJobsRepository _inner;

  @override
  Future<RiderBoard> board() async {
    w.check();
    final m = FixtureData.board(w.empty ? 'idle' : w.board, now: w.now);
    final active = m['active'] as Map<String, dynamic>?;
    if (active != null && w.approvals) {
      active['podPhotoRequired'] = false;
      active['exceptions'] = [
        for (final (i, kind) in [(1, 'vendor_delay'), (2, 'customer_unreachable')])
          {
            'id': 'f3000000-0000-4000-8000-00000000000$i',
            'kind': kind,
            'status': 'approved',
            'reason': 'Shop was running late with the order',
            'decisionNote': 'Checked with the shop',
            'createdAt': _iso(w.now),
          },
      ];
    }
    if (w.long) {
      // An extra held offer, cash to collect, a long instruction.
      final offers = (m['offers'] as List).cast<Map<String, dynamic>>();
      if (offers.isNotEmpty) {
        offers.first['instructions'] = longInstructions;
        (offers.first['payment'] as Map)['collectAmount'] = 12485;
      }
      return RiderBoard.fromJson(_lengthen(m, null)! as Map<String, dynamic>);
    }
    return RiderBoard.fromJson(m);
  }

  /// Refused with the longest words a refusal has.
  @override
  Future<void> accept(String orderId) async => throw longError();

  @override
  Future<void> reject(String orderId, String reason, {String? note}) => _inner.reject(orderId, reason, note: note);

  @override
  Future<ActionOutcome> act(QueuedAction a) => _inner.act(a);

  @override
  Future<String> uploadProof(String orderId, File photo) => _inner.uploadProof(orderId, photo);

  @override
  Future<void> logContact(String orderId, String target) async {}

  @override
  Future<String> raiseException({
    required String orderId,
    required String kind,
    required String reason,
    String? notes,
    String? photoPath,
    double? lat,
    double? lng,
  }) async => throw longError();
}

// ---------------------------------------------------------------------------
// Dashboard, history, performance
// ---------------------------------------------------------------------------

class ScaleInsights implements InsightsRepository {
  ScaleInsights(this.w)
    : _inner = FixtureInsightsRepository.create(scenario: w.empty ? 'empty' : 'busy', now: w.now);

  final ScaleWorld w;
  final FixtureInsightsRepository _inner;

  @override
  Future<RiderDashboard> dashboard() async {
    w.check();
    if (!w.long || w.empty) return _inner.dashboard();
    final now = w.now;
    return RiderDashboard.fromJson({
      'today': {
        'deliveries': 1234,
        'pending': 128,
        'accepted': 117,
        'pickedUp': 106,
        'completed': 1004,
        'cancelled': 222,
        'failed': 121,
      },
      'money': {'today': 123456.75, 'total': 98765432.5, 'pending': -123456.25, 'incentivesThisWeek': 1234567},
      'availability': {
        'isOnline': true,
        'breakUntil': null,
        'onlineSince': _iso(now.subtract(const Duration(hours: 11, minutes: 59))),
        'lastFixAt': _iso(now),
      },
      'phase': 'online',
      'current': {
        'orderId': 'f2000000-0000-4000-8000-000000000001',
        'code': '#FX662012345',
        'status': 'arrived_drop',
        'next': 'Hand over the order to the customer at the door, then tap Delivered on the delivery screen',
      },
      'nearestTarget': {'name': 'Weekend evening rush hour super champion challenge', 'done': 1032, 'target': 4000, 'bonus': 123456},
      'updatedAt': _iso(now),
    });
  }

  Map<String, dynamic> _row(int i) {
    final ended = w.now.subtract(Duration(hours: 1 + i * 5));
    final outcome = const ['delivered', 'failed', 'cancelled', 'reassigned', 'delivered'][i % 5];
    final delivered = outcome == 'delivered';
    return {
      'orderId': 'f3000000-0000-4000-8000-${i.toString().padLeft(12, '0')}',
      'code': '#FX${662012345 + i}',
      'shop': longShop,
      'dropArea': longArea,
      'outcome': outcome,
      'acceptedAt': _iso(ended.subtract(const Duration(minutes: 128))),
      'pickedUpAt': outcome == 'reassigned' ? null : _iso(ended.subtract(const Duration(minutes: 64))),
      'deliveredAt': delivered ? _iso(ended) : null,
      'endedAt': _iso(ended),
      'distanceKm': 123.4,
      'earning': delivered ? 12345.5 : null,
      'reason': delivered ? null : longReason,
      'cancelledBy': outcome == 'cancelled' ? 'admin' : null,
      'proof': delivered ? 'photo' : null,
      'itemCount': 112,
      'orderValue': 123456,
    };
  }

  @override
  Future<HistoryPage> history({String? from, String? to, String? outcome, String? cursor}) async {
    w.check();
    if (w.empty) return HistoryPage.fromJson({'items': const [], 'nextCursor': null});
    if (!w.long) return _inner.history(from: from, to: to, outcome: outcome, cursor: cursor);
    // Two pages: the second one ends the list.
    final start = cursor == null ? 0 : 12;
    final rows = [for (var i = start; i < start + 12; i++) _row(i)].where((r) => outcome == null || r['outcome'] == outcome);
    return HistoryPage.fromJson({'items': rows.toList(), 'nextCursor': cursor == null ? '12' : null});
  }

  @override
  Future<HistoryDetail> historyDetail(String orderId) async {
    w.check();
    final i = int.tryParse(orderId.split('-').last) ?? 0;
    final row = _row(i);
    return HistoryDetail.fromJson({
      ...row,
      'timeline': [
        {'kind': 'offered', 'method': null, 'reason': null, 'at': row['acceptedAt']},
        {'kind': 'accepted', 'method': null, 'reason': null, 'at': row['acceptedAt']},
        {'kind': 'arrived_pickup', 'method': null, 'reason': null, 'at': row['acceptedAt']},
        {'kind': 'picked_up', 'method': 'manual', 'reason': null, 'at': row['pickedUpAt']},
        {'kind': 'note', 'method': 'instructions_changed', 'reason': longInstructions, 'at': row['endedAt']},
        {'kind': 'contact_attempt', 'method': 'customer', 'reason': null, 'at': row['endedAt']},
        {'kind': row['outcome'] == 'reassigned' ? 'released' : row['outcome'], 'method': 'ops_approved', 'reason': row['reason'], 'at': row['endedAt']},
      ],
      'proofPhotoUrl': row['outcome'] == 'delivered' ? 'https://example.invalid/proof.jpg' : null,
      'items': [
        {'name': longItem, 'qty': 12},
        {'name': 'Butter naan', 'qty': 100},
      ],
    });
  }

  @override
  Future<RiderPerformance> performance() async {
    w.check();
    if (!w.long || w.empty) return _inner.performance();
    final base = await _inner.performance();
    return RiderPerformance.fromJson({
      'daily': {'target': 1200, 'done': 1050},
      'weekly': {'target': 6000, 'done': 5999},
      'avgAcceptToDeliverMin': 1234,
      'avgPickupToDeliverMin': 999,
      'acceptanceRate': 100,
      'failedRate': 12.5,
      'onlineHoursThisWeek': 167.5,
      'rating': {
        'average': 4.95,
        'count': 123456,
        'recent': [
          {
            'rating': 5,
            'comment':
                'Very polite rider, reached before time even in heavy rain, the food was hot and the packaging was intact',
            'at': _iso(w.now.subtract(const Duration(days: 1))),
          },
          {'rating': 1, 'comment': null, 'at': _iso(w.now.subtract(const Duration(days: 2)))},
        ],
      },
      'months': [
        for (final m in base.months)
          {
            'month': m.month,
            'delivered': 12345,
            'failed': 1234,
            'cancelled': 1234,
            'acceptanceRate': 100,
            'avgDeliverMin': 1234,
            'earnings': 1234567.5,
            'onlineHours': 744,
          },
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

/// A record with every part filled in, and long words in it.
EarningRecord longRecord(DateTime now, {String kind = 'delivery'}) => EarningRecord.fromJson({
  'kind': kind,
  'id': 'long-$kind',
  'orderId': 'order-long',
  'orderCode': '#FX662012345',
  'date': istDayKey(now),
  'baseFee': 12345.5,
  'distanceKm': 123.4,
  'distanceSource': 'estimate',
  'distanceFee': 12345.5,
  'minTopup': 12345.5,
  'tip': 12345.5,
  'tipInCash': true,
  'incentive': 12345.5,
  'deduction': 12345.5,
  'amount': 1234567.5,
  'status': 'paid',
  'settledOn': istDayKey(now),
  'reference': 'NEFT/HDFC0001234/2026102212345678901234',
  'note': 'Weekend evening rush hour super champion challenge (Bemetara zone)',
  'reversed': true,
  'reversesId': null,
});

class ScaleEarnings implements EarningsRepository {
  ScaleEarnings(this.w) : _inner = FixtureEarningsRepository.create(scenario: w.empty ? 'empty' : 'paid');

  final ScaleWorld w;
  final FixtureEarningsRepository _inner;

  @override
  Future<EarningsSummary> summary() async {
    w.check();
    if (!w.long || w.empty) return _inner.summary();
    return EarningsSummary.fromJson({
      'today': 123456.75,
      'week': 1234567.5,
      'month': 12345678.25,
      'total': 98765432.5,
      'perDeliveryAvg': null,
      'deliveriesCounted': 12345,
      'incentives': 1234567.5,
      'bonuses': 1234567.5,
      'adjustments': -1234567.5,
      'deductions': 1234567.5,
      'salary': 12345678.5,
      'paid': 98765432.5,
      'pending': -1234567.5,
      'lastPayout': {
        'amount': 12345678.5,
        'paidOn': istDayKey(w.now),
        'reference': 'NEFT/HDFC0001234/2026102212345678901234',
      },
    });
  }

  @override
  Future<RecordsPage> records({required String from, required String to, String? cursor, int limit = 50}) async {
    w.check();
    if (cursor == 'more') return const RecordsPage(items: []);
    final page = await _inner.records(from: from, to: to, cursor: cursor, limit: limit);
    if (!w.long || w.empty) return page;
    return RecordsPage(
      items: [longRecord(w.now, kind: 'incentive'), longRecord(w.now, kind: 'deduction'), ...page.items],
      nextCursor: 'more',
    );
  }

  @override
  Future<List<Payout>> payouts() async {
    w.check();
    final list = await _inner.payouts();
    if (!w.long || w.empty) return list;
    return [
      Payout.fromJson({
        'id': 'p-long',
        'amount': 12345678.5,
        'method': 'bank_transfer',
        'reference': 'NEFT/HDFC0001234/2026102212345678901234',
        'paidOn': istDayKey(w.now),
        'periodEnd': istDayKey(w.now),
        'items': 1234,
      }),
      ...list,
    ];
  }

  @override
  Future<List<IncentiveProgress>> incentives() async {
    w.check();
    final list = await _inner.incentives();
    if (!w.long || w.empty) return list;
    return [
      IncentiveProgress.fromJson({
        'ruleId': 'rule-long',
        'name': 'Weekend evening rush hour super champion challenge (Bemetara zone)',
        'period': 'weekly',
        'target': 4000,
        'done': 1032,
        'bonus': 123456.5,
        'window': '18:00–22:00',
        'endsOn': istDayKey(w.now.add(const Duration(days: 300))),
        'earned': false,
      }),
      ...list,
    ];
  }

  @override
  Future<Statement> statement(String from, String to) async {
    w.check();
    final s = await _inner.statement(from, to);
    if (!w.long || w.empty) return s;
    return Statement.fromJson({
      'riderCode': 'DR-004212345',
      'name': longRider,
      'from': from,
      'to': to,
      'openingPending': -12345678.5,
      'earned': 12345678.5,
      'paid': 98765432.5,
      'closingPending': -98765432.5,
      'rows': [
        {
          'kind': 'deduction',
          'id': 'long-row',
          'orderId': null,
          'orderCode': null,
          'date': to,
          'baseFee': null,
          'distanceKm': null,
          'distanceSource': null,
          'distanceFee': null,
          'minTopup': null,
          'tip': null,
          'tipInCash': null,
          'incentive': null,
          'deduction': 1234567.5,
          'amount': -1234567.5,
          'status': 'paid',
          'settledOn': to,
          'reference': 'NEFT/HDFC0001234/2026102212345678901234',
          'note': 'Damaged insulated delivery bag replaced at the Bemetara hub',
          'reversed': false,
          'reversesId': null,
        },
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// Cash
// ---------------------------------------------------------------------------

class ScaleCash implements CashRepository {
  ScaleCash(this.w) : _inner = FixtureCashRepository.create(scenario: w.empty ? 'empty' : 'holding', now: w.now);

  final ScaleWorld w;
  final FixtureCashRepository _inner;

  String _day(int ago) => addDays(istDayKey(w.now), -ago);

  @override
  Future<CashSummary> summary() async {
    w.check();
    final s = await _inner.summary();
    if (!w.long || w.empty) return s;
    return CashSummary(
      toCollect: 1234567,
      collectedToday: 1234567,
      depositedToday: 1234567,
      collectedTotal: 98765432,
      depositedTotal: 12345678,
      pending: 9876543,
      submittedAwaiting: 1234567,
      oldestUndepositedAt: w.now.subtract(const Duration(hours: 250)),
      overLimit: true,
      overHours: true,
      limit: 1234567,
      maxHours: 168,
      days: [
        CashDay(day: _day(0), collected: 1234567, deposited: 1234567, status: DayStatus.pending),
        CashDay(day: _day(1), collected: 1234567, deposited: 0, status: DayStatus.disputed, note: longTicket),
        ...s.days,
      ],
    );
  }

  @override
  Future<CollectionsPage> collections({required String from, required String to, String? cursor, int limit = 50}) async {
    w.check();
    final page = await _inner.collections(from: from, to: to, cursor: cursor, limit: limit);
    if (!w.long || w.empty) return page;
    return CollectionsPage(
      items: [
        CashCollection(orderId: 'long-1', code: '#FX662012345', at: w.now, amount: 1234567, online: false, status: 'not_recorded'),
        CashCollection(orderId: 'long-2', code: '#FX662012346', at: w.now, amount: 1234567, online: true, status: 'paid_online'),
        ...page.items,
      ],
    );
  }

  @override
  Future<List<CashDeposit>> deposits() async {
    w.check();
    final list = await _inner.deposits();
    if (!w.long || w.empty) return list;
    return [
      CashDeposit(
        id: 'long-dep',
        amount: 1234567,
        upi: true,
        status: DepositStatus.submitted,
        createdAt: w.now,
        managerName: longManager,
        reference: 'UPI/412345678901/HDFC/BEMETARA',
        hasReceipt: true,
        note: longNote,
      ),
      CashDeposit(
        id: 'long-dep-2',
        amount: 1234567,
        upi: false,
        status: DepositStatus.disputed,
        createdAt: w.now,
        managerName: longManager,
        decisionNote: longTicket,
      ),
      ...list,
    ];
  }

  @override
  Future<List<CashManager>> managers() async {
    w.check();
    return [
      if (w.long) const CashManager(id: 'mgr-long', name: longManager),
      ...await _inner.managers(),
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
  }) async => throw longError();

  @override
  Future<void> withdrawDeposit(String id) async => throw longError();

  @override
  Future<List<CashDispute>> disputes() async {
    w.check();
    final list = await _inner.disputes();
    if (!w.long || w.empty) return list;
    return [
      CashDispute(id: 'long-dis', day: _day(2), message: longTicket, open: true, claimedAmount: 1234567),
      CashDispute(
        id: 'long-dis-2',
        day: _day(3),
        message: longTicket,
        open: false,
        claimedAmount: 1234567,
        resolution: longNote,
      ),
      ...list,
    ];
  }

  @override
  Future<String> raiseDispute({required String day, required String message, int? claimedAmount}) async =>
      throw longError();
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

class ScaleProfile implements ProfileRepository {
  ScaleProfile(this.w) : _inner = FixtureProfileRepository.create(scenario: w.empty ? 'new' : 'mixed', now: w.now);

  final ScaleWorld w;
  final FixtureProfileRepository _inner;

  Map<String, dynamic> _doc(String type, String status, {int? days, String? remarks}) {
    final today = istDayKey(w.now);
    return {
      'id': 'doc-$type',
      'type': type,
      'numberMasked': 'XXXX-XXXX-XXXX-4821',
      'expiresOn': days == null ? null : addDays(today, days),
      'daysLeft': days,
      'status': status,
      'remarks': remarks,
      'uploadedAt': _iso(w.now.subtract(const Duration(days: 30))),
    };
  }

  @override
  Future<RiderProfile> profile() async {
    w.check();
    if (!w.long || w.empty) return _inner.profile();
    final today = istDayKey(w.now);
    return RiderProfile.fromJson({
      'riderCode': 'DR-004212345',
      'name': longRider,
      'phone': '+919876543210',
      'avatarUrl': null,
      'address': {'line': longDropLine, 'city': 'Bemetara (Chhattisgarh)', 'pincode': '491335'},
      'vehicle': {'type': 'scooter', 'owner': 'rider', 'registration': 'CG07AB12345678'},
      'licence': {'number': 'CG0720260012345', 'expiresOn': addDays(today, 12)},
      'emergency': {'name': longCustomer, 'phone': '+919822012345', 'relation': longRelation},
      'payoutAccount': {'kind': 'bank', 'masked': 'XXXXXXXXXXXX4521'},
      'verification': 'rejected',
      'documents': [
        _doc('aadhaar', 'verified'),
        _doc('driving_licence', 'expired', days: -123),
        _doc('photo', 'rejected', remarks: 'The photo is blurry and your face is half hidden. Take it again in good light, without a helmet.'),
        _doc('pan', 'pending'),
        _doc('rc', 'verified', days: 3),
        _doc('insurance', 'verified', days: 0),
      ],
      'pendingChanges': [
        {'id': 'chg-1', 'field': 'full_name', 'createdAt': _iso(w.now), 'summary': '$longRider Yadav'},
        {'id': 'chg-2', 'field': 'payout_account', 'createdAt': _iso(w.now), 'summary': 'XXXXXXXXXXXX4521 · HDFC0001234'},
      ],
      'needsAttention': true,
    });
  }

  @override
  Future<List<ChangeRequestView>> changeRequests() async {
    w.check();
    final list = await _inner.changeRequests();
    if (!w.long || w.empty) return list;
    return [
      ChangeRequestView.fromJson({
        'id': 'chg-long',
        'field': 'vehicle',
        'status': 'rejected',
        'createdAt': _iso(w.now.subtract(const Duration(days: 9))),
        'decidedAt': _iso(w.now.subtract(const Duration(days: 8))),
        'decisionNote': 'The registration number does not match the RC you uploaded. Upload a clear photo of both sides.',
        'summary': 'Scooter · CG07AB12345678',
      }),
      ...list,
    ];
  }

  @override
  Future<void> saveDirect({Map<String, Object?>? address, Map<String, Object?>? emergency}) async => throw longError();

  @override
  Future<ChangeOutcome> requestChange(String field, Map<String, Object?> value) async => throw longError();

  @override
  Future<void> uploadDocument({
    required String type,
    String? number,
    String? expiresOn,
    required PickedDocument file,
  }) async => throw longError();

  @override
  Future<DocumentContent> openDocument(String id) => _inner.openDocument(id);

  @override
  Future<void> uploadAvatar(File photo) async {}

  @override
  Future<void> sendPhoneCode(String phone) async {}

  @override
  Future<void> updatePhone(String phone, String code) async => throw longError();
}

// ---------------------------------------------------------------------------
// Help, notifications, safety
// ---------------------------------------------------------------------------

class ScaleSupport implements SupportRepository {
  ScaleSupport(this.w) : _inner = FixtureSupportRepository.create(now: w.now);

  final ScaleWorld w;
  final FixtureSupportRepository _inner;

  Map<String, dynamic> _ticket(int number, String category, String label, String priority, String status, String statusLabel) => {
    'id': 'f7000000-0000-4000-8000-${number.toString().padLeft(12, '0')}',
    'number': number,
    'category': category,
    'categoryLabel': label,
    'priority': priority,
    'subject': longTicket,
    'status': status,
    'statusLabel': statusLabel,
    'orderId': 'f1000000-0000-4000-8000-000000000001',
    'orderCode': '#FX662012345',
    'createdAt': _iso(w.now.subtract(const Duration(days: 3))),
    'updatedAt': _iso(w.now),
    'resolvedAt': status == 'resolved' ? _iso(w.now) : null,
  };

  List<Map<String, dynamic>> get _tickets => [
    _ticket(1234567, 'accident_emergency', 'Accident or emergency', 'emergency', 'waiting_on_requester', 'Waiting for your reply'),
    _ticket(1234568, 'cash_reconciliation', 'Cash or deposit problem', 'normal', 'resolved', 'Resolved'),
  ];

  @override
  Future<SupportOverview> overview() async {
    w.check();
    final base = await _inner.overview();
    if (w.empty) {
      return SupportOverview.fromJson({
        'tickets': const [],
        'contact': {'phone': null, 'whatsapp': null},
        'categories': [for (final c in base.categories) {'key': c.key, 'label': c.label}],
        'safetyCategories': const [],
      });
    }
    if (!w.long) return base;
    return SupportOverview.fromJson({
      'tickets': _tickets,
      'contact': {'phone': '+91 98765 43210', 'whatsapp': '+91 98765 43210'},
      'categories': [for (final c in base.categories) {'key': c.key, 'label': c.label}],
      'safetyCategories': const [],
    });
  }

  @override
  Future<TicketThread> thread(String id) async {
    w.check();
    if (!w.long) return _inner.thread(id);
    final t = _tickets.where((t) => t['id'] == id).firstOrNull ?? _tickets.first;
    return TicketThread.fromJson({
      'ticket': {...t, 'lat': 21.7189, 'lng': 81.5301, 'locationUrl': 'https://maps.google.com/?q=21.7189,81.5301'},
      'messages': [
        {'id': 'm1', 'body': longTicket, 'fromStaff': false, 'authorRole': 'rider', 'attachments': const [], 'createdAt': _iso(w.now)},
        {
          'id': 'm2',
          'body': '$longNote $longNote',
          'fromStaff': true,
          'authorRole': 'manager',
          'attachments': const [
            {'url': 'https://example.invalid/photo.jpg'},
          ],
          'createdAt': _iso(w.now),
        },
      ],
    });
  }

  @override
  Future<CreatedTicket> create({
    required String category,
    String? subject,
    required String message,
    String? orderId,
    List<File> photos = const [],
    double? lat,
    double? lng,
  }) async => throw longError();

  @override
  Future<void> reply(String id, String message, {List<File> photos = const []}) async => throw longError();

  @override
  Future<List<RecentOrder>> recentOrders() async {
    w.check();
    if (w.empty) return const [];
    return [
      if (w.long) const RecentOrder(orderId: 'f1000000-0000-4000-8000-000000000009', code: '#FX662012345', shop: longShop),
      ...await _inner.recentOrders(),
    ];
  }
}

class ScaleNotifications implements NotificationsRepository {
  ScaleNotifications(this.w) : _inner = FixtureNotificationsRepository.create(now: w.now);

  final ScaleWorld w;
  final FixtureNotificationsRepository _inner;

  @override
  Future<InboxPage> inbox({String? before, int limit = 30}) async {
    w.check();
    if (w.empty) {
      return InboxPage.fromJson({'available': true, 'notifications': const [], 'unread': 0, 'hasMore': false, 'nextBefore': null});
    }
    final page = await _inner.inbox(before: before, limit: limit);
    if (!w.long) return page;
    return InboxPage.fromJson({
      'available': true,
      'notifications': [
        {
          'id': 'n-long',
          'category': 'cash',
          'title': 'Deposit your cash in hand: you are over the limit by ₹12,34,567',
          'body': longTicket,
          'data': {'url': '/more/cash'},
          'read': false,
          'readAt': null,
          'createdAt': _iso(w.now),
        },
      ],
      'unread': 1234,
      'hasMore': true,
      'nextBefore': _iso(w.now),
    });
  }

  @override
  Future<void> markRead(List<String> ids) async {}

  @override
  Future<void> markAllRead() async {}

  @override
  Future<List<Announcement>> announcements() async {
    w.check();
    if (w.empty) return const [];
    if (!w.long) return _inner.announcements();
    return [
      Announcement.fromJson({
        'id': 'a-long',
        'audience': 'rider',
        'title': 'Diwali week: most shops in Bemetara close early on 29 and 30 October',
        'body': '$longNote $longInstructions',
        'startsAt': _iso(w.now.subtract(const Duration(days: 1))),
        'endsAt': _iso(w.now.add(const Duration(days: 8))),
      }),
    ];
  }

  @override
  Future<NotificationPrefs?> loadPrefs() => _inner.loadPrefs();

  @override
  Future<void> savePrefs(NotificationPrefs prefs) => _inner.savePrefs(prefs);
}

class ScaleSafety implements SafetyRepository {
  ScaleSafety(this.w);

  final ScaleWorld w;

  @override
  Future<SosAck> sos({
    required SosKind kind,
    double? lat,
    double? lng,
    String? note,
    String? orderId,
    List<File> photos = const [],
  }) async {
    if (w.sosOffline) throw networkError();
    return const SosAck(ticketId: 'f7000000-0000-4000-8000-000000001060', number: 1234567, deduped: false);
  }

  @override
  Future<EmergencyContact?> emergencyContact() async {
    if (w.fail) throw networkError();
    if (w.noContact || w.empty) return null;
    return w.long
        ? const EmergencyContact(name: longCustomer, phone: '+91 91234 56780', relation: longRelation)
        : const EmergencyContact(name: 'Sunita Kumar', phone: '+91 91234 56780', relation: 'Wife');
  }
}
