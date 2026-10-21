import 'package:uuid/uuid.dart';

import 'cash.dart' show CashRider;
import 'json_util.dart';
import 'vendors.dart' show PersonRef;

/// A rider's delivery exception (§6 manual intervention, deferred from Phase
/// 3): a request ops approve or reject, or a report ops acknowledge.

enum ExceptionKind {
  customerUnreachable('customer_unreachable', 'Customer unreachable'),
  wrongAddress('wrong_address', 'Wrong address'),
  completeWithoutCode('complete_without_code', 'Complete without the code'),
  failedDelivery('failed_delivery', 'Delivery failed'),
  manualPickup('manual_pickup', 'Pickup without the code'),
  goOffline('go_offline', 'Go offline mid-job'),
  returnToShop('return_to_shop', 'Returning to the shop'),
  missingItems('missing_items', 'Items missing'),
  wrongPackage('wrong_package', 'Wrong package'),
  vendorDelay('vendor_delay', 'Kitchen delay'),
  other('other', 'Other issue'),
  unknown('unknown', 'Issue');

  const ExceptionKind(this.wire, this.label);
  final String wire;
  final String label;

  static ExceptionKind parse(Object? s) =>
      // The server stores the free-form report kind as `other_issue`.
      s == 'other_issue' ? other : jEnum(values, s, unknown, (v) => v.wire);

  /// Approving these cancels the order (and refunds per the usual rules).
  bool get cancelsOrder => this == failedDelivery || this == customerUnreachable || this == wrongAddress;
}

enum ExceptionStatus {
  pending('Needs a decision'),
  approved('Approved'),
  rejected('Rejected'),
  acknowledged('Acknowledged'),
  unknown('Unknown');

  const ExceptionStatus(this.label);
  final String label;

  static ExceptionStatus parse(Object? s) => jEnum(values, s, unknown);
}

enum ExceptionDecision {
  approve('Approve'),
  reject('Reject'),
  acknowledge('Acknowledge'),
  unknown('');

  const ExceptionDecision(this.label);
  final String label;

  static ExceptionDecision parse(Object? s) => jEnum(values, s, unknown);
}

class DeliveryException {
  const DeliveryException({
    required this.id,
    required this.orderId,
    required this.orderCode,
    required this.rider,
    required this.kind,
    required this.reason,
    required this.status,
    this.notes,
    this.hasPhoto = false,
    this.lat,
    this.lng,
    this.decidedBy,
    this.decidedAt,
    this.decisionNote,
    this.createdAt,
    this.decisions = const [],
  });

  factory DeliveryException.fromJson(Map<String, dynamic> j) => DeliveryException(
        id: jStrOr(j['id']),
        orderId: jStrOr(j['orderId']),
        orderCode: jStrOr(j['orderCode']),
        rider: CashRider.fromJson(jMap(j['rider'])),
        kind: ExceptionKind.parse(j['kind']),
        reason: jStrOr(j['reason']),
        notes: jStr(j['notes']),
        hasPhoto: jBool(j['hasPhoto']),
        lat: jDoubleOrNull(j['lat']),
        lng: jDoubleOrNull(j['lng']),
        status: ExceptionStatus.parse(j['status']),
        decidedBy: PersonRef.fromJson(j['decidedBy']),
        decidedAt: jDate(j['decidedAt']),
        decisionNote: jStr(j['decisionNote']),
        createdAt: jDate(j['createdAt']),
        decisions: [
          for (final d in jStrings(j['decisions']))
            if (ExceptionDecision.parse(d) != ExceptionDecision.unknown) ExceptionDecision.parse(d),
        ],
      );

  final String id;
  final String orderId;
  final String orderCode;
  final CashRider rider;
  final ExceptionKind kind;
  final String reason;
  final String? notes;
  final bool hasPhoto;
  final double? lat;
  final double? lng;
  final ExceptionStatus status;
  final PersonRef? decidedBy;
  final DateTime? decidedAt;
  final String? decisionNote;
  final DateTime? createdAt;

  /// What this viewer may do now; empty once decided or without
  /// `manager.exceptions.decide`.
  final List<ExceptionDecision> decisions;
}

class ExceptionPage {
  const ExceptionPage({required this.items, this.nextCursor, this.pending = 0});
  factory ExceptionPage.fromJson(Map<String, dynamic> j) => ExceptionPage(
        items: [for (final e in jMaps(j['items'])) DeliveryException.fromJson(e)],
        nextCursor: jStr(j['nextCursor']),
        pending: jInt(jMap(j['counts'])?['pending']),
      );
  final List<DeliveryException> items;
  final String? nextCursor;
  final int pending;
}

const _uuid = Uuid();

/// One decision on one exception. Made once: Retry after `effect_failed`
/// re-sends the very same id, and the server answers with the recorded
/// decision and finishes the effect once.
class ExceptionAction {
  ExceptionAction(this.decision, {this.note, String? clientActionId}) : clientActionId = clientActionId ?? _uuid.v4();
  final ExceptionDecision decision;
  final String? note;
  final String clientActionId;

  Map<String, dynamic> toJson() => {
        'clientActionId': clientActionId,
        'decision': decision.name,
        if (note != null && note!.trim().isNotEmpty) 'note': note!.trim(),
      };
}
