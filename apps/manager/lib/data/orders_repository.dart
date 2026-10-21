import '../core/api.dart';
import '../models/live.dart';
import '../models/orders.dart';

/// Orders across this manager's zones (§3) — `/api/manager/orders*`.
abstract interface class OrdersRepository {
  Future<OrderPage> list(OrderFilters f, {String? cursor});
  Future<OrderDetail> detail(String id);
  Future<List<RiderCandidate>> riders(String id);

  /// A refusal the manager can read is an [ActionRefused]; a network or
  /// server fault is thrown as [ApiException] so the caller can retry with the
  /// same action (and so the same `clientActionId`).
  Future<ActionOutcome> act(String id, OrderAction a);
}

/// The live operations board (§6) — `/api/manager/live`.
abstract interface class LiveRepository {
  Future<LiveSnapshot> snapshot({String? zoneId});
}

/// Page size for the Orders list (contract default 50).
const orderPageSize = 50;

/// Status codes whose `error` is a decision about this action, not a fault.
const _refusalStatuses = {400, 403, 404, 409, 429};

class ApiOrdersRepository implements OrdersRepository {
  ApiOrdersRepository(this._api);
  final ApiClient _api;

  @override
  Future<OrderPage> list(OrderFilters f, {String? cursor}) async => OrderPage.fromJson(
        await _api.get('/api/manager/orders', query: {
          ...f.toQuery(),
          'cursor': ?cursor,
          'limit': '$orderPageSize',
        }),
      );

  @override
  Future<OrderDetail> detail(String id) async {
    final res = await _api.get('/api/manager/orders/${Uri.encodeComponent(id)}');
    return OrderDetail.fromJson((res['order'] as Map).cast<String, dynamic>());
  }

  @override
  Future<List<RiderCandidate>> riders(String id) async =>
      parseRiderCandidates(await _api.get('/api/manager/orders/${Uri.encodeComponent(id)}/riders'));

  @override
  Future<ActionOutcome> act(String id, OrderAction a) async {
    try {
      final res = await _api.post('/api/manager/orders/${Uri.encodeComponent(id)}/actions', a.toJson());
      final ticket = res['ticket'];
      return ActionDone(
        OrderDetail.fromJson((res['order'] as Map).cast<String, dynamic>()),
        ticket: ticket is Map ? TicketRef.fromJson(ticket.cast<String, dynamic>()) : null,
      );
    } on ApiException catch (e) {
      // 401 stays an exception: the session handler signs the manager out.
      if (!_refusalStatuses.contains(e.status)) rethrow;
      final reasons = e.body['reasons'];
      return ActionRefused(
        e.status == 429 ? 'rate_limited' : e.code,
        [for (final r in (reasons is List ? reasons : const [])) if (r is String) r],
      );
    }
  }
}

class ApiLiveRepository implements LiveRepository {
  ApiLiveRepository(this._api);
  final ApiClient _api;

  @override
  Future<LiveSnapshot> snapshot({String? zoneId}) async =>
      LiveSnapshot.fromJson(await _api.get('/api/manager/live', query: {'zone': ?zoneId}));
}
