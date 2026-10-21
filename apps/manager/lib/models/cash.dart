import 'package:uuid/uuid.dart';

import 'json_util.dart';
import 'vendors.dart' show PersonRef;

/// Rider cash: deposits a rider declares and a manager confirms or disputes,
/// and disputes a rider raises about a day's count (§5.14). Amounts are whole
/// rupees.

enum CashMethod {
  cash('cash', 'Cash'),
  upi('upi', 'UPI'),
  unknown('unknown', 'Other');

  const CashMethod(this.wire, this.label);
  final String wire;
  final String label;

  static CashMethod parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

enum DepositStatus {
  submitted('Waiting for you'),
  confirmed('Confirmed'),
  disputed('Disputed'),
  withdrawn('Withdrawn'),
  unknown('Unknown');

  const DepositStatus(this.label);
  final String label;

  static DepositStatus parse(Object? s) => jEnum(values, s, unknown);
}

enum DisputeStatus {
  open('Open'),
  resolved('Resolved'),
  unknown('Unknown');

  const DisputeStatus(this.label);
  final String label;

  static DisputeStatus parse(Object? s) => jEnum(values, s, unknown);
}

/// `{ id, name, code }` for the rider a cash row belongs to.
class CashRider {
  const CashRider({required this.id, required this.name, this.code, this.phone});
  factory CashRider.fromJson(Map<String, dynamic>? j) => CashRider(
        id: jStrOr(j?['id']),
        name: jStrOr(j?['name'], 'Rider'),
        code: jStr(j?['code']),
        phone: jStr(j?['phone']),
      );
  final String id;
  final String name;
  final String? code;
  final String? phone;
}

class CashDeposit {
  const CashDeposit({
    required this.id,
    required this.rider,
    required this.amount,
    required this.method,
    required this.status,
    this.reference,
    this.hasPhoto = false,
    this.note,
    this.decidedBy,
    this.decidedAt,
    this.decisionNote,
    this.handoverId,
    this.createdAt,
  });

  factory CashDeposit.fromJson(Map<String, dynamic> j) => CashDeposit(
        id: jStrOr(j['id']),
        rider: CashRider.fromJson(jMap(j['rider'])),
        amount: jInt(j['amount']),
        method: CashMethod.parse(j['method']),
        reference: jStr(j['reference']),
        hasPhoto: jBool(j['hasPhoto']),
        note: jStr(j['note']),
        status: DepositStatus.parse(j['status']),
        decidedBy: PersonRef.fromJson(j['decidedBy']),
        decidedAt: jDate(j['decidedAt']),
        decisionNote: jStr(j['decisionNote']),
        handoverId: jStr(j['handoverId']),
        createdAt: jDate(j['createdAt']),
      );

  final String id;
  final CashRider rider;
  final int amount;
  final CashMethod method;
  final String? reference;
  final bool hasPhoto;
  final String? note;
  final DepositStatus status;
  final PersonRef? decidedBy;
  final DateTime? decidedAt;
  final String? decisionNote;
  final String? handoverId;
  final DateTime? createdAt;
}

class CashDispute {
  const CashDispute({
    required this.id,
    required this.rider,
    required this.day,
    required this.message,
    required this.status,
    this.claimedAmount,
    this.resolution,
    this.resolvedAt,
    this.createdAt,
  });

  factory CashDispute.fromJson(Map<String, dynamic> j) => CashDispute(
        id: jStrOr(j['id']),
        rider: CashRider.fromJson(jMap(j['rider'])),
        day: jStrOr(j['day']),
        claimedAmount: jIntOrNull(j['claimedAmount']),
        message: jStrOr(j['message']),
        status: DisputeStatus.parse(j['status']),
        resolution: jStr(j['resolution']),
        resolvedAt: jDate(j['resolvedAt']),
        createdAt: jDate(j['createdAt']),
      );

  final String id;
  final CashRider rider;
  final String day;
  final int? claimedAmount;
  final String message;
  final DisputeStatus status;
  final String? resolution;
  final DateTime? resolvedAt;
  final DateTime? createdAt;
}

class CashDepositPage {
  const CashDepositPage({required this.items, this.nextCursor, this.counts = const CashCounts()});
  factory CashDepositPage.fromJson(Map<String, dynamic> j) => CashDepositPage(
        items: [for (final d in jMaps(j['items'])) CashDeposit.fromJson(d)],
        nextCursor: jStr(j['nextCursor']),
        counts: CashCounts.fromJson(jMap(j['counts'])),
      );
  final List<CashDeposit> items;
  final String? nextCursor;
  final CashCounts counts;
}

class CashCounts {
  const CashCounts({this.submitted = 0});
  factory CashCounts.fromJson(Map<String, dynamic>? j) => CashCounts(submitted: jInt(j?['submitted']));
  final int submitted;
}

class CashDisputePage {
  const CashDisputePage({required this.items, this.nextCursor});
  factory CashDisputePage.fromJson(Map<String, dynamic> j) => CashDisputePage(
        items: [for (final d in jMaps(j['items'])) CashDispute.fromJson(d)],
        nextCursor: jStr(j['nextCursor']),
      );
  final List<CashDispute> items;
  final String? nextCursor;
}

const _uuid = Uuid();

/// Confirm or dispute one deposit; the id is made once so Retry is the same
/// decision.
class DepositDecision {
  DepositDecision.confirm({String? clientActionId})
      : confirm = true,
        note = null,
        clientActionId = clientActionId ?? _uuid.v4();
  DepositDecision.dispute(String this.note, {String? clientActionId})
      : confirm = false,
        clientActionId = clientActionId ?? _uuid.v4();

  final bool confirm;
  final String? note;
  final String clientActionId;

  Map<String, dynamic> toJson() => {
        'clientActionId': clientActionId,
        'decision': confirm ? 'confirm' : 'dispute',
        'note': ?note,
      };
}

class DisputeResolution {
  DisputeResolution(this.resolution, {String? clientActionId}) : clientActionId = clientActionId ?? _uuid.v4();
  final String resolution;
  final String clientActionId;

  Map<String, dynamic> toJson() => {'clientActionId': clientActionId, 'resolution': resolution};
}
