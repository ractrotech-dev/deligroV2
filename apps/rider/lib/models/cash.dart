/// The rider's cash as `/api/rider/cash/*` sends it (src/lib/rider/cash-math.ts,
/// src/lib/data-access/rider-cash.ts). Amounts are whole rupees, instants are
/// ISO UTC strings, days are IST `YYYY-MM-DD` keys.
///
/// This is cash collected for Deligro. It is not the rider's earnings and
/// nothing here is ever added to them.
library;

int _int(Object? v) {
  if (v is num) return v.round();
  if (v is String) return int.tryParse(v) ?? double.tryParse(v)?.round() ?? 0;
  return 0;
}

String? _str(Object? v) {
  if (v is! String) return null;
  final t = v.trim();
  return t.isEmpty ? null : t;
}

/// How a day's cash stands (the status chip on the Cash screen).
enum DayStatus {
  settled('Settled'),
  pending('Pending'),
  disputed('Disputed');

  const DayStatus(this.label);
  final String label;

  static DayStatus parse(Object? v) => DayStatus.values.firstWhere(
    (s) => s.name == v,
    orElse: () => DayStatus.pending,
  );
}

class CashDay {
  const CashDay({
    required this.day,
    required this.collected,
    required this.deposited,
    required this.status,
    this.note,
  });

  final String day;
  final int collected;
  final int deposited;
  final DayStatus status;

  /// The manager's note on a disputed deposit made that day.
  final String? note;

  factory CashDay.fromJson(Map<String, dynamic> j) => CashDay(
    day: '${j['day']}',
    collected: _int(j['collected']),
    deposited: _int(j['deposited']),
    status: DayStatus.parse(j['status']),
    note: _str(j['note']),
  );
}

/// `GET /api/rider/cash/summary`.
class CashSummary {
  const CashSummary({
    required this.toCollect,
    required this.collectedToday,
    required this.depositedToday,
    required this.collectedTotal,
    required this.depositedTotal,
    required this.pending,
    required this.submittedAwaiting,
    required this.oldestUndepositedAt,
    required this.overLimit,
    required this.overHours,
    required this.limit,
    required this.maxHours,
    required this.days,
  });

  final int toCollect;
  final int collectedToday;
  final int depositedToday;
  final int collectedTotal;
  final int depositedTotal;

  /// Collected less deposited (confirmed by a manager). Never below zero.
  final int pending;

  /// Deposits declared and waiting for a manager; not taken off [pending].
  final int submittedAwaiting;
  final DateTime? oldestUndepositedAt;
  final bool overLimit;
  final bool overHours;

  /// The admin thresholds the two flags were judged against; 0 = rule off.
  final int limit;
  final int maxHours;
  final List<CashDay> days;

  /// What the rider can still declare: held cash less deposits waiting.
  int get available => (pending - submittedAwaiting).clamp(0, pending);

  bool get over => overLimit || overHours;

  /// A rider who has never collected cash.
  bool get neverCollected => collectedTotal == 0 && days.isEmpty;

  factory CashSummary.fromJson(Map<String, dynamic> j) => CashSummary(
    toCollect: _int(j['toCollect']),
    collectedToday: _int(j['collectedToday']),
    depositedToday: _int(j['depositedToday']),
    collectedTotal: _int(j['collectedTotal']),
    depositedTotal: _int(j['depositedTotal']),
    pending: _int(j['pending']),
    submittedAwaiting: _int(j['submittedAwaiting']),
    oldestUndepositedAt: DateTime.tryParse('${j['oldestUndepositedAt']}'),
    overLimit: j['overLimit'] == true,
    overHours: j['overHours'] == true,
    limit: _int(j['limit']),
    maxHours: _int(j['maxHours']),
    days: [
      for (final e in (j['days'] as List? ?? const []))
        if (e is Map) CashDay.fromJson(Map<String, dynamic>.from(e)),
    ],
  );
}

/// One delivered order on the collections list.
class CashCollection {
  const CashCollection({
    required this.orderId,
    required this.code,
    required this.at,
    required this.amount,
    required this.online,
    required this.status,
  });

  final String orderId;
  final String code;
  final DateTime at;

  /// Cash collected, or for an online order the order total (never cash).
  final int amount;
  final bool online;

  /// `collected`, `not_recorded` or `paid_online`.
  final String status;

  bool get notRecorded => status == 'not_recorded';

  factory CashCollection.fromJson(Map<String, dynamic> j) => CashCollection(
    orderId: '${j['orderId']}',
    code: '${j['code']}',
    at:
        DateTime.tryParse('${j['at']}') ??
        DateTime.fromMillisecondsSinceEpoch(0),
    amount: _int(j['amount']),
    online: j['method'] == 'online' || j['status'] == 'paid_online',
    status: '${j['status']}',
  );
}

class CollectionsPage {
  const CollectionsPage({required this.items, this.nextCursor});

  final List<CashCollection> items;
  final String? nextCursor;

  factory CollectionsPage.fromJson(Map<String, dynamic> j) => CollectionsPage(
    items: [
      for (final e in (j['items'] as List? ?? const []))
        if (e is Map) CashCollection.fromJson(Map<String, dynamic>.from(e)),
    ],
    nextCursor: _str(j['nextCursor']),
  );
}

enum DepositStatus {
  submitted('Waiting for manager'),
  confirmed('Confirmed'),
  disputed('Disputed'),
  withdrawn('Withdrawn'),

  /// A status this app does not know (a newer server). Shown as "Under
  /// review" and never offers an action.
  unknown('Under review');

  const DepositStatus(this.label);
  final String label;

  static DepositStatus parse(Object? v) => DepositStatus.values.firstWhere(
    (s) => s.name == v && s != DepositStatus.unknown,
    orElse: () => DepositStatus.unknown,
  );
}

/// `GET /api/rider/cash/deposits`.
class CashDeposit {
  const CashDeposit({
    required this.id,
    required this.amount,
    required this.upi,
    required this.status,
    required this.createdAt,
    this.managerName,
    this.reference,
    this.note,
    this.hasReceipt = false,
    this.decisionNote,
  });

  final String id;
  final int amount;
  final bool upi;
  final DepositStatus status;
  final DateTime createdAt;
  final String? managerName;
  final String? reference;
  final String? note;
  final bool hasReceipt;

  /// The manager's note on a disputed deposit.
  final String? decisionNote;

  String get methodLabel => upi ? 'UPI' : 'Cash';

  factory CashDeposit.fromJson(Map<String, dynamic> j) => CashDeposit(
    id: '${j['id']}',
    amount: _int(j['amount']),
    upi: j['method'] == 'upi',
    status: DepositStatus.parse(j['status']),
    createdAt:
        DateTime.tryParse('${j['createdAt']}') ??
        DateTime.fromMillisecondsSinceEpoch(0),
    managerName: _str(j['managerName']),
    reference: _str(j['reference']),
    note: _str(j['note']),
    hasReceipt: j['hasReceipt'] == true,
    decisionNote: _str(j['decisionNote']),
  );
}

/// `GET /api/rider/cash/managers`: id and name only.
class CashManager {
  const CashManager({required this.id, required this.name});

  final String id;
  final String name;

  factory CashManager.fromJson(Map<String, dynamic> j) =>
      CashManager(id: '${j['id']}', name: _str(j['name']) ?? 'Manager');
}

/// `GET /api/rider/cash/disputes`: "this day's figure is wrong".
class CashDispute {
  const CashDispute({
    required this.id,
    required this.day,
    required this.message,
    required this.open,
    this.claimedAmount,
    this.resolution,
  });

  final String id;
  final String day;
  final String message;
  final bool open;
  final int? claimedAmount;
  final String? resolution;

  factory CashDispute.fromJson(Map<String, dynamic> j) => CashDispute(
    id: '${j['id']}',
    day: '${j['day']}',
    message: '${j['message'] ?? ''}',
    open: j['status'] != 'resolved',
    claimedAmount: j['claimedAmount'] == null ? null : _int(j['claimedAmount']),
    resolution: _str(j['resolution']),
  );
}
