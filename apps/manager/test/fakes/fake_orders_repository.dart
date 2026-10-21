import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/data/orders_repository.dart';
import 'package:deligro_manager/models/live.dart';
import 'package:deligro_manager/models/orders.dart';

import '../fixtures/fixtures.dart';

/// Records every call and answers from the contract fixtures (or from
/// whatever a test puts in the `next…` slots).
class FakeOrdersRepository implements OrdersRepository {
  FakeOrdersRepository({OrderPage? page, OrderDetail? detail, List<RiderCandidate>? riders})
      : page = page ?? OrderPage.fromJson(apiFixture('orders_list')),
        detailValue = detail ?? OrderDetail.fromJson(apiFixture('order_detail')['order'] as Map<String, dynamic>),
        ridersValue = riders ?? parseRiderCandidates(apiFixture('order_riders'));

  OrderPage page;

  /// Answers for a given cursor (null = first page). Falls back to [page].
  final Map<String?, OrderPage> pages = {};
  OrderDetail detailValue;
  List<RiderCandidate> ridersValue;

  /// Thrown by the next `list` / `detail` / `act` call, then cleared.
  Object? listError;
  Object? detailError;
  Object? actError;

  /// Queued outcomes for `act`; when empty, `ActionDone(detailValue)`.
  final List<ActionOutcome> outcomes = [];

  final listCalls = <({OrderFilters filters, String? cursor})>[];
  final detailCalls = <String>[];
  final riderCalls = <String>[];
  final actCalls = <({String id, OrderAction action})>[];

  @override
  Future<OrderPage> list(OrderFilters f, {String? cursor}) async {
    listCalls.add((filters: f, cursor: cursor));
    final e = listError;
    if (e != null) {
      listError = null;
      throw e;
    }
    return pages[cursor] ?? page;
  }

  @override
  Future<OrderDetail> detail(String id) async {
    detailCalls.add(id);
    final e = detailError;
    if (e != null) {
      detailError = null;
      throw e;
    }
    return detailValue;
  }

  @override
  Future<List<RiderCandidate>> riders(String id) async {
    riderCalls.add(id);
    return ridersValue;
  }

  @override
  Future<ActionOutcome> act(String id, OrderAction a) async {
    actCalls.add((id: id, action: a));
    final e = actError;
    if (e != null) {
      actError = null;
      throw e;
    }
    return outcomes.isEmpty ? ActionDone(detailValue) : outcomes.removeAt(0);
  }
}

class FakeLiveRepository implements LiveRepository {
  FakeLiveRepository({LiveSnapshot? snapshot}) : value = snapshot ?? LiveSnapshot.fromJson(apiFixture('live'));

  LiveSnapshot value;
  Object? error;
  final calls = <String?>[];

  @override
  Future<LiveSnapshot> snapshot({String? zoneId}) async {
    calls.add(zoneId);
    final e = error;
    if (e != null) {
      error = null;
      throw e;
    }
    return value;
  }
}

/// A network fault as the ApiClient raises it.
ApiException networkError() => ApiException(0, 'network');
