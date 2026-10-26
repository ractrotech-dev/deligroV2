import '../core/api.dart';
import '../models/order.dart';

/// The vendor's orders. Every status change goes through the website's
/// routes, which send the pushes, dispatch the rider, queue refunds and stop
/// the ring — the app never writes an order row itself.
class OrdersRepository {
  OrdersRepository(this._api);

  final ApiClient _api;

  List<VendorOrder> _list(Object? raw) => [
    for (final o in (raw as List? ?? const [])) VendorOrder.fromJson((o as Map).cast<String, dynamic>()),
  ];

  /// New, accepted, preparing, ready and out-for-delivery orders, newest first.
  Future<List<VendorOrder>> board() async => _list((await _api.get('/api/vendor/orders/board'))['orders']);

  /// Completed or cancelled orders. [range]: `all`, `this_month`,
  /// `previous_month`, or `date` with [date] as YYYY-MM-DD.
  Future<({List<VendorOrder> orders, int total})> history({
    required String kind,
    String range = 'all',
    String? date,
    String? search,
    int limit = 100,
    int offset = 0,
  }) async {
    final res = await _api.get(
      '/api/vendor/orders/history',
      query: {
        'kind': kind,
        'range': range,
        'date': ?date,
        if (search != null && search.trim().isNotEmpty) 'search': search.trim(),
        'limit': '$limit',
        if (offset > 0) 'offset': '$offset',
      },
    );
    return (orders: _list(res['orders']), total: (res['total'] as num?)?.toInt() ?? 0);
  }

  Future<VendorOrder> detail(String id) async =>
      VendorOrder.fromJson(((await _api.get('/api/vendor/orders/$id'))['order'] as Map).cast<String, dynamic>());

  Future<void> accept(String id, {int? prepMinutes}) =>
      _api.patch('/api/orders/$id/status', {'status': 'kitchen', 'prepMinutes': ?prepMinutes});

  Future<void> reject(String id, String reason) =>
      _api.patch('/api/orders/$id/status', {'status': 'cancelled', 'reason': reason});
}
