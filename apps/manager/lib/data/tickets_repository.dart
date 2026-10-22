import '../core/api.dart';
import '../models/outcome.dart';
import '../models/support_ops.dart';
import '../models/tickets.dart';

/// Support tickets — `/api/manager/tickets*` (Phase 4 thread, Phase 8 queue,
/// assignment, priority, escalation, attachments and metrics). One interface
/// for every ticket screen.
abstract interface class TicketsRepository {
  Future<TicketListPage> list(TicketFilters f, {String? cursor});
  Future<TicketThread> thread(String id);

  /// Refusals → [Refused]; faults throw [ApiException] (retry, same id).
  /// A reply with files goes as multipart.
  Future<Outcome<void>> reply(String id, TicketReply r);
  Future<Outcome<void>> setStatus(String id, TicketStatusChange s);
  Future<Outcome<void>> assign(String id, TicketAssign a);
  Future<Outcome<void>> priority(String id, TicketPriorityChange p);

  /// The new escalation level on success.
  Future<Outcome<int>> escalate(String id, TicketEscalate e);

  Future<AssigneeList> assignees({String? zoneId});
  Future<TicketMetrics> metrics({required DateTime from, required DateTime to, String? zoneId});
}

class ApiTicketsRepository implements TicketsRepository {
  ApiTicketsRepository(this._api);
  final ApiClient _api;

  static const _base = '/api/manager/tickets';
  String _p(String id) => '$_base/${Uri.encodeComponent(id)}';

  static String _day(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  @override
  Future<TicketListPage> list(TicketFilters f, {String? cursor}) async =>
      TicketListPage.fromJson(await _api.get(_base, query: {...f.toQuery(), 'cursor': ?cursor}));

  @override
  Future<TicketThread> thread(String id) async => TicketThread.fromJson(await _api.get(_p(id)));

  @override
  Future<Outcome<void>> reply(String id, TicketReply r) => runAction<void>(() async {
        if (r.files.isEmpty) return _api.post('${_p(id)}/messages', r.toJson());
        return _api.postMultipartFiles(
          '${_p(id)}/messages',
          fields: {'body': r.body, 'internal': '${r.internal}', 'clientActionId': r.clientActionId},
          fileField: 'files[]',
          files: [for (final f in r.files) (bytes: await f.readAsBytes(), name: f.name)],
        );
      }, (_) {});

  @override
  Future<Outcome<void>> setStatus(String id, TicketStatusChange s) =>
      runAction<void>(() => _api.post('${_p(id)}/status', s.toJson()), (_) {});

  @override
  Future<Outcome<void>> assign(String id, TicketAssign a) =>
      runAction<void>(() => _api.post('${_p(id)}/assign', a.toJson()), (_) {});

  @override
  Future<Outcome<void>> priority(String id, TicketPriorityChange p) =>
      runAction<void>(() => _api.post('${_p(id)}/priority', p.toJson()), (_) {});

  @override
  Future<Outcome<int>> escalate(String id, TicketEscalate e) =>
      runAction<int>(() => _api.post('${_p(id)}/escalate', e.toJson()), (res) => res['level'] is num ? (res['level'] as num).round() : null);

  @override
  Future<AssigneeList> assignees({String? zoneId}) async =>
      AssigneeList.fromJson(await _api.get('$_base/assignees', query: {'zone': ?zoneId}));

  @override
  Future<TicketMetrics> metrics({required DateTime from, required DateTime to, String? zoneId}) async =>
      TicketMetrics.fromJson(await _api.get('$_base/metrics', query: {'from': _day(from), 'to': _day(to), 'zone': ?zoneId}));
}
