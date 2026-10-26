import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';
import '../models/order.dart';
import '../models/tracking.dart';

class PlacedOrder {
  const PlacedOrder(this.order);
  final Order order;
}

class OrderRepository {
  OrderRepository(this._db, this._api);
  final SupabaseClient _db;
  final ApiClient _api;

  static const activeStatuses = ['placed', 'kitchen', 'ready', 'on_the_way'];

  String? get _uid => _db.auth.currentUser?.id;

  /// False once the database is known to predate 0062 (no order_items.options).
  static bool? _hasOptions;

  /// Runs [query] with the options column while it may exist, and without it
  /// once PostgREST says it doesn't (42703).
  Future<T> _withOptions<T>(Future<T> Function(String columns) query) async {
    if (_hasOptions == false) return query(Order.columns);
    try {
      final out = await query(Order.columnsWithOptions);
      _hasOptions = true;
      return out;
    } on PostgrestException catch (e) {
      if (e.code != '42703') rethrow;
      _hasOptions = false;
      return query(Order.columns);
    }
  }

  /// The customer's own orders, newest first (listMyOrders on the web).
  Future<List<Order>> myOrders({List<String>? statuses, int limit = 30}) async {
    final uid = _uid;
    if (uid == null) return const [];
    final rows = await _withOptions((columns) {
      var q = _db.from('orders').select(columns).eq('customer_id', uid);
      if (statuses != null) q = q.inFilter('status', statuses);
      return q.order('created_at', ascending: false).limit(limit);
    });
    return [for (final r in rows) Order.fromRow(r)];
  }

  Future<Order?> activeOrder() async {
    final list = await myOrders(statuses: activeStatuses, limit: 1);
    return list.isEmpty ? null : list.first;
  }

  Future<Order?> byId(String id) async {
    final row = await _withOptions((columns) => _db.from('orders').select(columns).eq('id', id).maybeSingle());
    return row == null ? null : Order.fromRow(row);
  }

  /// Delivered/cancelled orders before [before], 100 per page.
  Future<({List<Order> orders, bool hasMore})> history({DateTime? before}) async {
    final res = await _api.get(
      '/api/orders/history',
      query: before == null ? null : {'before': before.toUtc().toIso8601String()},
    );
    return (
      orders: [
        for (final o in (res['orders'] as List? ?? const []))
          Order.fromUi(Map<String, dynamic>.from(o as Map)),
      ],
      hasMore: res['hasMore'] == true,
    );
  }

  /// `POST /api/orders`. The server re-prices everything; the returned order
  /// is the real bill.
  Future<Order> place({
    required String restaurantSlug,
    required List<({String itemId, int qty, String? variantId, List<String> addonIds})> lines,
    required String addressLabel,
    required String addressLine,
    double? lat,
    double? lng,
    required int tip,
    required String paymentMethod,
    String? couponCode,
    required String idempotencyKey,

    /// The courier note, already trimmed and capped — sent beside the address,
    /// not inside it (`orders.delivery_instructions` on the server).
    String? instructions,
  }) async {
    final res = await _api.post('/api/orders', {
      'restaurantSlug': restaurantSlug,
      'lines': [
        for (final l in lines)
          {
            'itemId': l.itemId,
            'qty': l.qty,
            // The server re-prices the chosen size and add-ons itself.
            if (l.variantId != null) 'variantId': l.variantId,
            if (l.addonIds.isNotEmpty) 'addonIds': l.addonIds,
          },
      ],
      'address': {'label': addressLabel, 'line': addressLine, 'lat': lat, 'lng': lng},
      'tip': tip,
      'paymentMethod': paymentMethod,
      if (couponCode != null && couponCode.isNotEmpty) 'couponCode': couponCode,
      'idempotencyKey': idempotencyKey,
      if (instructions != null && instructions.isNotEmpty) 'instructions': instructions,
    });
    return Order.fromRow(Map<String, dynamic>.from(res['order'] as Map));
  }

  /// Only while placed/kitchen; 409 `too_late` otherwise.
  Future<bool> cancel(String orderId) async {
    final res = await _api.post('/api/orders/$orderId/cancel');
    return res['refundQueued'] == true;
  }

  Future<TrackingSnapshot> tracking(String orderId) async {
    final res = await _api.get('/api/orders/$orderId/tracking');
    return TrackingSnapshot.fromJson(Map<String, dynamic>.from(res['tracking'] as Map));
  }

  /// A 10-minute link to the rider's door photo (`GET /api/orders/:id/proof`),
  /// or null when there is none — no photo taken, or none the rider was asked
  /// for. Never throws: the link is an extra, and its absence is not an error.
  Future<String?> proofUrl(String orderId) async => (await proof(orderId)).url;

  /// The door photo's state: a 10-minute [url], or [removed] when the photo
  /// was deleted under the 90-day retention rule (the server says so instead
  /// of a link), or neither. Never throws.
  Future<({String? url, bool removed})> proof(String orderId) async {
    try {
      final res = await _api.get('/api/orders/$orderId/proof');
      final url = res['url'];
      return (url: url is String && url.isNotEmpty ? url : null, removed: res['removed'] == true);
    } catch (_) {
      return (url: null, removed: false);
    }
  }

  Future<void> review(String orderId, int rating, {String? comment}) => _api.post(
        '/api/reviews',
        {'orderId': orderId, 'rating': rating, if (comment != null && comment.isNotEmpty) 'comment': comment},
      );

  /// What this customer already rated the rider for [orderId]
  /// (`GET /api/orders/:id/rider-rating`), or null when they have not rated
  /// (or the answer could not be read - the card then offers the stars, and
  /// the server says `already_rated` if it was wrong). Never throws.
  Future<({int rating, String? comment})?> riderRating(String orderId) async {
    try {
      final res = await _api.get('/api/orders/$orderId/rider-rating');
      final rating = res['rating'];
      if (rating is! num) return null;
      final comment = res['comment'];
      return (rating: rating.round(), comment: comment is String && comment.isNotEmpty ? comment : null);
    } catch (_) {
      return null;
    }
  }

  /// Rate the rider who delivered [orderId] (`POST /api/orders/:id/rider-rating`).
  /// One rating per order; throws [ApiException] with the route's code
  /// (`already_rated`, `not_delivered`, `no_rider`, `comment_too_long`, ...).
  Future<void> rateRider(String orderId, int rating, {String? comment}) => _api.post(
        '/api/orders/$orderId/rider-rating',
        {'rating': rating, if (comment != null && comment.isNotEmpty) 'comment': comment},
      );

  Future<void> requestRefund(String orderId, String reason) =>
      _api.post('/api/refunds', {'orderId': orderId, 'reason': reason});

  /// Live prices for a reorder check: itemId → (effective price, available).
  Future<({bool open, Map<String, ({int price, bool available})> items})> menuPrices(
    String slug,
  ) async {
    final res = await _api.get('/api/restaurants/$slug/menu-prices');
    return (
      open: res['open'] == true,
      items: {
        for (final i in (res['items'] as List? ?? const []))
          '${(i as Map)['id']}': (
            price: (i['price'] as num).round(),
            available: i['available'] != false,
          ),
      },
    );
  }
}
