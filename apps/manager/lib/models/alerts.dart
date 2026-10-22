import 'package:uuid/uuid.dart';

import 'json_util.dart';

/// Ops alerts (§14, §6.7–6.8) as `/api/manager/alerts*` sends them.

enum AlertKind {
  orderNeedsIntervention('order_needs_intervention', 'Order needs attention'),
  orderUnassigned('order_unassigned', 'Unassigned order'),
  deliveryDelayed('delivery_delayed', 'Delayed delivery'),
  highCancellationRate('high_cancellation_rate', 'High cancellation rate'),
  vendorDowntime('vendor_downtime', 'Vendor downtime'),
  riderShortage('rider_shortage', 'Rider shortage'),
  deliveryFailed('delivery_failed', 'Failed delivery'),
  settlementDelayed('settlement_delayed', 'Settlement delay'),
  riderPayoutIssue('rider_payout_issue', 'Rider payout issue'),
  marketingRequestNew('marketing_request_new', 'New marketing request'),
  complaintHighPriority('complaint_high_priority', 'High-priority complaint'),
  cashDiscrepancy('cash_discrepancy', 'Cash discrepancy'),
  incident('incident', 'Incident'),
  riderInactive('rider_inactive', 'Rider inactive'),
  fraudSuspected('fraud_suspected', 'Possible fraud'),
  slaBreach('sla_breach', 'SLA breach'),
  unknown('unknown', 'Alert');

  const AlertKind(this.wire, this.label);
  final String wire;
  final String label;

  static AlertKind parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

enum AlertSeverity {
  critical('critical', 'Critical'),
  warning('warning', 'Warning'),
  info('info', 'Info');

  const AlertSeverity(this.wire, this.label);
  final String wire;
  final String label;

  static AlertSeverity parse(Object? s) => jEnum(values, s, info, (v) => v.wire);
}

enum AlertStatus {
  open('open', 'Open'),
  acknowledged('acknowledged', 'Acknowledged'),
  resolved('resolved', 'Resolved'),
  unknown('unknown', 'Unknown');

  const AlertStatus(this.wire, this.label);
  final String wire;
  final String label;

  static AlertStatus parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

class AlertPerson {
  const AlertPerson({required this.id, required this.name});

  static AlertPerson? maybe(Object? v) {
    final r = jRef(v);
    return r == null ? null : AlertPerson(id: r.id, name: r.name.isEmpty ? 'Someone' : r.name);
  }

  final String id;
  final String name;
}

class Alert {
  const Alert({
    required this.id,
    required this.kind,
    required this.severity,
    required this.status,
    required this.title,
    this.body = '',
    this.zoneId,
    this.entityType = '',
    this.entityId = '',
    this.openedAt,
    this.lastSeenAt,
    this.reopenCount = 0,
    this.acknowledgedBy,
    this.acknowledgedAt,
    this.resolvedAt,
    this.resolution,
    this.resolvedBy,
  });

  factory Alert.fromJson(Map<String, dynamic> j) {
    final e = jMap(j['entity']) ?? const {};
    return Alert(
      id: jStrOr(j['id']),
      kind: AlertKind.parse(j['kind']),
      severity: AlertSeverity.parse(j['severity']),
      status: AlertStatus.parse(j['status']),
      title: jStrOr(j['title'], 'Alert'),
      body: jStrOr(j['body']),
      zoneId: jStr(j['zoneId']),
      entityType: jStrOr(e['type']),
      entityId: jStrOr(e['id']),
      openedAt: jDate(j['openedAt']),
      lastSeenAt: jDate(j['lastSeenAt']),
      reopenCount: jInt(j['reopenCount']),
      acknowledgedBy: AlertPerson.maybe(j['acknowledgedBy']),
      acknowledgedAt: jDate(j['acknowledgedAt']),
      resolvedAt: jDate(j['resolvedAt']),
      resolution: jStr(j['resolution']),
      resolvedBy: AlertPerson.maybe(j['resolvedBy']),
    );
  }

  final String id;
  final AlertKind kind;
  final AlertSeverity severity;
  final AlertStatus status;
  final String title;
  final String body;
  final String? zoneId;
  final String entityType;
  final String entityId;
  final DateTime? openedAt;
  final DateTime? lastSeenAt;
  final int reopenCount;
  final AlertPerson? acknowledgedBy;
  final DateTime? acknowledgedAt;
  final DateTime? resolvedAt;
  final String? resolution;
  final AlertPerson? resolvedBy;

  bool get isResolved => status == AlertStatus.resolved;

  /// Cleared by the system when the condition went away, not by a person.
  bool get cleared => isResolved && resolution == 'cleared' && resolvedBy == null;
}

/// Critical first, then most recently seen — the server's order, re-applied
/// after a local change moves an alert between lists.
List<Alert> sortAlerts(List<Alert> items) {
  int rank(AlertSeverity s) => switch (s) {
        AlertSeverity.critical => 0,
        AlertSeverity.warning => 1,
        AlertSeverity.info => 2,
      };
  final out = [...items];
  out.sort((a, b) {
    final r = rank(a.severity).compareTo(rank(b.severity));
    if (r != 0) return r;
    return (b.lastSeenAt ?? DateTime(0)).compareTo(a.lastSeenAt ?? DateTime(0));
  });
  return out;
}

class AlertCounts {
  const AlertCounts({this.open = 0, this.acknowledged = 0, this.critical = 0});

  factory AlertCounts.fromJson(Map<String, dynamic>? j) =>
      AlertCounts(open: jInt(j?['open']), acknowledged: jInt(j?['acknowledged']), critical: jInt(j?['critical']));

  final int open;
  final int acknowledged;
  final int critical;
}

class AlertPage {
  const AlertPage({required this.items, required this.counts, this.nextCursor});

  factory AlertPage.fromJson(Map<String, dynamic> j) => AlertPage(
        items: [for (final a in jMaps(j['items'])) Alert.fromJson(a)],
        counts: AlertCounts.fromJson(jMap(j['counts'])),
        nextCursor: jStr(j['nextCursor']),
      );

  final List<Alert> items;
  final AlertCounts counts;
  final String? nextCursor;
}

class AlertHistoryEntry {
  const AlertHistoryEntry({required this.event, this.at, this.actor, this.note});

  factory AlertHistoryEntry.fromJson(Map<String, dynamic> j) => AlertHistoryEntry(
        event: jStrOr(j['event']),
        at: jDate(j['at']),
        actor: AlertPerson.maybe(j['actor']),
        note: jStr(j['note']),
      );

  final String event;
  final DateTime? at;
  final AlertPerson? actor;
  final String? note;

  String get label => switch (event) {
        'opened' => 'Opened',
        'escalated_severity' => 'Severity raised',
        'acknowledged' => 'Acknowledged',
        'resolved' => 'Resolved',
        'cleared' => 'Cleared on its own',
        'reopened' => 'Reopened',
        _ => event.isEmpty ? 'Updated' : event,
      };
}

class AlertDetail {
  const AlertDetail({required this.alert, this.history = const []});

  factory AlertDetail.fromJson(Map<String, dynamic> j) => AlertDetail(
        alert: Alert.fromJson(jMap(j['alert']) ?? const {}),
        history: [for (final h in jMaps(j['history'])) AlertHistoryEntry.fromJson(h)],
      );

  final Alert alert;
  final List<AlertHistoryEntry> history;
}

/// The list's filters: which statuses, kinds, severities and zone.
class AlertFilters {
  const AlertFilters({this.status = AlertStatus.open, this.kinds = const {}, this.severities = const {}, this.zoneId});

  final AlertStatus status;
  final Set<AlertKind> kinds;
  final Set<AlertSeverity> severities;
  final String? zoneId;

  Map<String, String> toQuery() => {
        'status': status.wire,
        if (kinds.isNotEmpty) 'kind': (kinds.map((k) => k.wire).toList()..sort()).join(','),
        if (severities.isNotEmpty) 'severity': (severities.map((s) => s.wire).toList()..sort()).join(','),
        'zone': ?zoneId,
      };

  AlertFilters copyWith({AlertStatus? status, Set<AlertKind>? kinds, Set<AlertSeverity>? severities, Object? zoneId = _unset}) =>
      AlertFilters(
        status: status ?? this.status,
        kinds: kinds ?? this.kinds,
        severities: severities ?? this.severities,
        zoneId: identical(zoneId, _unset) ? this.zoneId : zoneId as String?,
      );

  static const _unset = Object();

  @override
  bool operator ==(Object other) => other is AlertFilters && other.toQuery().toString() == toQuery().toString();

  @override
  int get hashCode => toQuery().toString().hashCode;
}

const _uuid = Uuid();

/// Acknowledge or resolve. One id per intent; Retry resends the same one.
class AlertAction {
  AlertAction.acknowledge({String? clientActionId})
      : action = 'acknowledge',
        note = null,
        clientActionId = clientActionId ?? _uuid.v4();
  AlertAction.resolve(String this.note, {String? clientActionId})
      : action = 'resolve',
        clientActionId = clientActionId ?? _uuid.v4();

  final String action;
  final String? note;
  final String clientActionId;

  Map<String, dynamic> toJson() => {'action': action, 'note': ?note, 'clientActionId': clientActionId};
}

/// A manager-raised incident (§14.13).
class IncidentDraft {
  IncidentDraft({required this.title, required this.body, required this.severity, required this.zoneId, String? clientActionId})
      : clientActionId = clientActionId ?? _uuid.v4();

  final String title;
  final String body;
  final AlertSeverity severity;
  final String zoneId;
  final String clientActionId;

  Map<String, dynamic> toJson() =>
      {'title': title, 'body': body, 'severity': severity.wire, 'zoneId': zoneId, 'clientActionId': clientActionId};
}

enum ThresholdUnit {
  minutes('minutes', 'min', 1, 1440),
  percent('percent', '%', 1, 100),
  ratio('ratio', '×', 0.5, 20),
  rupees('rupees', '₹', 50, 100000),
  none('none', '', 0, 0);

  const ThresholdUnit(this.wire, this.suffix, this.min, this.max);
  final String wire;
  final String suffix;
  final num min;
  final num max;

  static ThresholdUnit parse(Object? s) => jEnum(values, s, none, (v) => v.wire);

  /// Shown under a field that is out of range: "1–1440".
  String get bounds => '${_n(min)}–${_n(max)}';

  static String _n(num v) => v == v.roundToDouble() ? '${v.round()}' : '$v';
}

/// One alert kind's threshold for a zone (or the platform default).
class AlertRule {
  const AlertRule({
    required this.kind,
    required this.kindWire,
    required this.enabled,
    required this.threshold,
    required this.unit,
    this.zoneId,
    this.inherited = false,
    this.windowMinutes,
    this.updatedBy,
    this.updatedAt,
    this.label = '',
    this.description = '',
  });

  factory AlertRule.fromJson(Map<String, dynamic> j) => AlertRule(
        kind: AlertKind.parse(j['kind']),
        kindWire: jStrOr(j['kind']),
        zoneId: jStr(j['zoneId']),
        inherited: jBool(j['inherited']),
        enabled: jBool(j['enabled']),
        threshold: (j['threshold'] is num) ? j['threshold'] as num : 0,
        unit: ThresholdUnit.parse(j['unit']),
        windowMinutes: jIntOrNull(j['windowMinutes']),
        updatedBy: AlertPerson.maybe(j['updatedBy']),
        updatedAt: jDate(j['updatedAt']),
        label: jStrOr(j['label'], AlertKind.parse(j['kind']).label),
        description: jStrOr(j['description']),
      );

  static List<AlertRule> listFromJson(Map<String, dynamic> j) => [for (final r in jMaps(j['rules'])) AlertRule.fromJson(r)];

  final AlertKind kind;
  final String kindWire;
  final String? zoneId;
  final bool inherited;
  final bool enabled;
  final num threshold;
  final ThresholdUnit unit;
  final int? windowMinutes;
  final AlertPerson? updatedBy;
  final DateTime? updatedAt;
  final String label;
  final String description;

  bool get hasThreshold => unit != ThresholdUnit.none;
}

/// A changed rule, sent with its own id.
class AlertRuleChange {
  AlertRuleChange({
    required this.kind,
    required this.zoneId,
    required this.enabled,
    required this.threshold,
    this.windowMinutes,
    String? clientActionId,
  }) : clientActionId = clientActionId ?? _uuid.v4();

  final String kind;
  final String? zoneId;
  final bool enabled;
  final num threshold;
  final int? windowMinutes;
  final String clientActionId;

  Map<String, dynamic> toJson() => {
        'kind': kind,
        'zoneId': zoneId,
        'enabled': enabled,
        'threshold': threshold,
        'windowMinutes': windowMinutes,
        'clientActionId': clientActionId,
      };
}
