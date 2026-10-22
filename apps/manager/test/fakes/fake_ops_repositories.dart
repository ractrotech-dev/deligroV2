import 'package:deligro_manager/data/alerts_repository.dart';
import 'package:deligro_manager/data/audit_repository.dart';
import 'package:deligro_manager/data/inbox_repository.dart';
import 'package:deligro_manager/models/alerts.dart';
import 'package:deligro_manager/models/audit.dart';
import 'package:deligro_manager/models/inbox.dart';
import 'package:deligro_manager/models/outcome.dart';

import '../fixtures/fixtures.dart';

Map<String, dynamic> p8(String name) => apiFixture('phase8/$name');

T? _pop<T>(List<T> q) => q.isEmpty ? null : q.removeAt(0);

/// Alerts held in memory: acknowledging or resolving moves an alert between
/// the lists the way the server would.
class FakeAlertsRepository implements AlertsRepository {
  FakeAlertsRepository() {
    _all = [...AlertPage.fromJson(p8('alerts_list')).items];
    rulesValue = AlertRule.listFromJson(p8('alert_rules'));
  }

  late List<Alert> _all;
  late List<AlertRule> rulesValue;
  Object? actError;
  final List<Outcome<Alert>> actOutcomes = [];

  final listCalls = <AlertFilters>[];
  final actCalls = <(String, AlertAction)>[];
  final incidentCalls = <IncidentDraft>[];
  final setRuleCalls = <AlertRuleChange>[];
  final resetCalls = <(String, String)>[];

  @override
  Future<AlertPage> list(AlertFilters f, {String? cursor}) async {
    listCalls.add(f);
    final items = _all.where((a) => a.status == f.status).toList();
    return AlertPage(
      items: sortAlerts(items),
      counts: AlertCounts(
        open: _all.where((a) => a.status == AlertStatus.open).length,
        acknowledged: _all.where((a) => a.status == AlertStatus.acknowledged).length,
        critical: _all.where((a) => a.severity == AlertSeverity.critical && !a.isResolved).length,
      ),
    );
  }

  @override
  Future<AlertDetail> detail(String id) async => AlertDetail.fromJson(p8('alert_detail'));

  @override
  Future<Outcome<Alert>> act(String id, AlertAction a) async {
    actCalls.add((id, a));
    final e = actError;
    if (e != null) {
      actError = null;
      throw e;
    }
    final queued = _pop(actOutcomes);
    if (queued != null) return queued;
    final i = _all.indexWhere((x) => x.id == id);
    final old = _all[i];
    final next = Alert(
      id: old.id,
      kind: old.kind,
      severity: old.severity,
      status: a.action == 'acknowledge' ? AlertStatus.acknowledged : AlertStatus.resolved,
      title: old.title,
      body: old.body,
      zoneId: old.zoneId,
      entityType: old.entityType,
      entityId: old.entityId,
      openedAt: old.openedAt,
      lastSeenAt: old.lastSeenAt,
      resolution: a.note,
    );
    _all[i] = next;
    return Applied(next);
  }

  @override
  Future<Outcome<Alert>> raiseIncident(IncidentDraft d) async {
    incidentCalls.add(d);
    final a = Alert(
      id: 'inc-1',
      kind: AlertKind.incident,
      severity: d.severity,
      status: AlertStatus.open,
      title: d.title,
      body: d.body,
      zoneId: d.zoneId,
      entityType: 'incident',
      entityId: 'manual:x',
    );
    _all.add(a);
    return Applied(a);
  }

  @override
  Future<List<AlertRule>> rules({String? zoneId}) async => rulesValue;

  @override
  Future<Outcome<AlertRule>> setRule(AlertRuleChange c) async {
    setRuleCalls.add(c);
    return const Applied();
  }

  @override
  Future<Outcome<void>> resetRule(String kind, String zoneId) async {
    resetCalls.add((kind, zoneId));
    return const Applied();
  }
}

class FakeInboxRepository implements InboxRepository {
  FakeInboxRepository({this.count = const UnreadCount(unread: 7, openAlerts: 5, criticalAlerts: 1)});

  UnreadCount count;
  late List<InboxItem> items = InboxPage.fromJson(p8('inbox')).items;
  final markCalls = <(List<String>?, bool)>[];
  int countCalls = 0;

  @override
  Future<InboxPage> list({String? cursor, bool unreadOnly = false}) async =>
      InboxPage(items: items, unread: items.where((i) => i.isUnread).length);

  @override
  Future<UnreadCount> unreadCount() async {
    countCalls++;
    return count;
  }

  @override
  Future<int> markRead({List<String>? ids, bool all = false}) async {
    markCalls.add((ids, all));
    final now = DateTime.now();
    items = [for (final i in items) (all || (ids ?? const []).contains(i.id)) ? i.markedRead(now) : i];
    return items.where((i) => i.isUnread).length;
  }
}

class FakeAuditRepository implements AuditRepository {
  final listCalls = <AuditFilters>[];

  @override
  Future<AuditPage> list(AuditFilters f, {String? cursor}) async {
    listCalls.add(f);
    return AuditPage.fromJson(p8('audit_list'));
  }

  @override
  Future<AuditEntryDetail> entry(int id) async => AuditEntryDetail.fromJson(p8('audit_entry'));

  @override
  Future<List<AuditActionDef>> actions() async => AuditActionDef.listFromJson(p8('audit_actions'));
}
