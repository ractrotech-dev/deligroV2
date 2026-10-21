import '../core/api.dart';
import '../models/outcome.dart';
import '../models/tickets.dart';

/// One support ticket's thread — `/api/manager/tickets/[id]*`. Phase 8 adds
/// the queue and assignment on the same endpoints.
abstract interface class TicketsRepository {
  Future<TicketThread> thread(String id);

  /// Refusals → [Refused]; faults throw [ApiException] (retry, same id).
  Future<Outcome<void>> reply(String id, TicketReply r);
  Future<Outcome<void>> setStatus(String id, TicketStatusChange s);
}

class ApiTicketsRepository implements TicketsRepository {
  ApiTicketsRepository(this._api);
  final ApiClient _api;

  String _p(String id) => '/api/manager/tickets/${Uri.encodeComponent(id)}';

  @override
  Future<TicketThread> thread(String id) async => TicketThread.fromJson(await _api.get(_p(id)));

  @override
  Future<Outcome<void>> reply(String id, TicketReply r) =>
      runAction<void>(() => _api.post('${_p(id)}/messages', r.toJson()), (_) {});

  @override
  Future<Outcome<void>> setStatus(String id, TicketStatusChange s) =>
      runAction<void>(() => _api.post('${_p(id)}/status', s.toJson()), (_) {});
}
