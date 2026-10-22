import '../core/api.dart';
import '../models/customers.dart';
import '../models/finance.dart' show RefundPage;
import '../models/outcome.dart';
import '../models/tickets.dart';

/// Customers (§10) — `/api/manager/customers*`.
abstract interface class CustomersRepository {
  Future<CustomerPage> list(CustomerFilters f, {String? cursor});
  Future<CustomerDetail> detail(String id);
  Future<TicketPage> complaints(String id, {String? cursor});
  Future<RefundPage> refunds(String id, {String? cursor});
  Future<CustomerFeedback> feedback(String id, {String? cursor});

  /// One audited reveal (§10.2). 403 without `manager.customers.contact`.
  Future<Outcome<ContactReveal>> revealContact(String id, ContactReason reason, {String? note, required String clientActionId});

  /// 409 `stale`, `not_a_customer` → [Refused]. 502 `effect_failed` (status
  /// saved, sign-in block not applied) is thrown so Retry resends the same id.
  Future<Outcome<CustomerDetail>> act(String id, CustomerAction a);
  Future<Retention> retention({String? from, String? to, String? zoneId});
}

const customersPageSize = 50;

class ApiCustomersRepository implements CustomersRepository {
  ApiCustomersRepository(this._api);
  final ApiClient _api;

  static const _base = '/api/manager/customers';
  String _p(String id) => '$_base/${Uri.encodeComponent(id)}';

  @override
  Future<CustomerPage> list(CustomerFilters f, {String? cursor}) async =>
      CustomerPage.fromJson(await _api.get(_base, query: {...f.toQuery(), 'cursor': ?cursor, 'limit': '$customersPageSize'}));

  @override
  Future<CustomerDetail> detail(String id) async =>
      CustomerDetail.fromJson(((await _api.get(_p(id)))['customer'] as Map).cast<String, dynamic>());

  @override
  Future<TicketPage> complaints(String id, {String? cursor}) async =>
      TicketPage.fromJson(await _api.get('${_p(id)}/complaints', query: {'cursor': ?cursor}));

  @override
  Future<RefundPage> refunds(String id, {String? cursor}) async =>
      RefundPage.fromJson(await _api.get('${_p(id)}/refunds', query: {'cursor': ?cursor}));

  @override
  Future<CustomerFeedback> feedback(String id, {String? cursor}) async =>
      CustomerFeedback.fromJson(await _api.get('${_p(id)}/feedback', query: {'cursor': ?cursor}));

  @override
  Future<Outcome<ContactReveal>> revealContact(String id, ContactReason reason, {String? note, required String clientActionId}) =>
      runAction(
        () => _api.post('${_p(id)}/contact', {
          'reason': reason.wire,
          if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
          'clientActionId': clientActionId,
        }),
        ContactReveal.fromJson,
      );

  @override
  Future<Outcome<CustomerDetail>> act(String id, CustomerAction a) => runAction(
        () => _api.post('${_p(id)}/actions', a.toJson()),
        (res) => res['customer'] is Map ? CustomerDetail.fromJson((res['customer'] as Map).cast<String, dynamic>()) : null,
      );

  @override
  Future<Retention> retention({String? from, String? to, String? zoneId}) async =>
      Retention.fromJson(await _api.get('$_base/retention', query: {'from': ?from, 'to': ?to, 'zone': ?zoneId}));
}
