import 'package:uuid/uuid.dart';

import '../core/api.dart';
import '../models/alerts.dart';
import '../models/outcome.dart';

/// Ops alerts, incidents and thresholds — `/api/manager/alerts*`,
/// `/api/manager/alert-rules`.
abstract interface class AlertsRepository {
  Future<AlertPage> list(AlertFilters f, {String? cursor});
  Future<AlertDetail> detail(String id);

  /// Refusals (`already_resolved`, …) → [Refused]; faults throw.
  Future<Outcome<Alert>> act(String id, AlertAction a);
  Future<Outcome<Alert>> raiseIncident(IncidentDraft d);

  Future<List<AlertRule>> rules({String? zoneId});
  Future<Outcome<AlertRule>> setRule(AlertRuleChange c);

  /// Drops a zone's own rule so it inherits the default again.
  Future<Outcome<void>> resetRule(String kind, String zoneId, {String? clientActionId});
}

class ApiAlertsRepository implements AlertsRepository {
  ApiAlertsRepository(this._api);
  final ApiClient _api;

  static const _base = '/api/manager/alerts';

  static Alert? _alert(Map<String, dynamic> res) {
    final a = res['alert'];
    return a is Map ? Alert.fromJson(a.cast<String, dynamic>()) : null;
  }

  @override
  Future<AlertPage> list(AlertFilters f, {String? cursor}) async =>
      AlertPage.fromJson(await _api.get(_base, query: {...f.toQuery(), 'cursor': ?cursor}));

  @override
  Future<AlertDetail> detail(String id) async =>
      AlertDetail.fromJson(await _api.get('$_base/${Uri.encodeComponent(id)}'));

  @override
  Future<Outcome<Alert>> act(String id, AlertAction a) =>
      runAction<Alert>(() => _api.post('$_base/${Uri.encodeComponent(id)}/actions', a.toJson()), _alert);

  @override
  Future<Outcome<Alert>> raiseIncident(IncidentDraft d) =>
      runAction<Alert>(() => _api.post('$_base/incident', d.toJson()), _alert);

  @override
  Future<List<AlertRule>> rules({String? zoneId}) async =>
      AlertRule.listFromJson(await _api.get('/api/manager/alert-rules', query: {'zone': ?zoneId}));

  @override
  Future<Outcome<AlertRule>> setRule(AlertRuleChange c) => runAction<AlertRule>(
        () => _api.put('/api/manager/alert-rules', c.toJson()),
        (res) => res['rule'] is Map ? AlertRule.fromJson((res['rule'] as Map).cast<String, dynamic>()) : null,
      );

  @override
  Future<Outcome<void>> resetRule(String kind, String zoneId, {String? clientActionId}) => runAction<void>(
        () => _api.delete(
          '/api/manager/alert-rules?kind=${Uri.encodeQueryComponent(kind)}&zone=${Uri.encodeQueryComponent(zoneId)}'
          '&clientActionId=${Uri.encodeQueryComponent(clientActionId ?? const Uuid().v4())}',
        ),
        (_) {},
      );
}
