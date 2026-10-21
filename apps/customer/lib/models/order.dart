/// Order shapes. Two sources speak two dialects:
///  * direct `orders` reads and the `/api/orders` 201 body are raw DB rows
///    (snake_case, lower-case status) — [Order.fromRow];
///  * `/api/orders/history` returns the web's camelCase `UiOrder` —
///    [Order.fromUi].
library;

import '../core/options.dart';

enum OrderStatus { placed, kitchen, ready, onTheWay, delivered, cancelled }

OrderStatus parseStatus(Object? v) {
  switch ('$v'.toLowerCase()) {
    case 'kitchen':
      return OrderStatus.kitchen;
    case 'ready':
      return OrderStatus.ready;
    case 'on_the_way':
      return OrderStatus.onTheWay;
    case 'delivered':
      return OrderStatus.delivered;
    case 'cancelled':
      return OrderStatus.cancelled;
    default:
      // Unknown values map to PLACED, as on the web (order-map.ts).
      return OrderStatus.placed;
  }
}

extension OrderStatusX on OrderStatus {
  String get label => switch (this) {
        OrderStatus.placed => 'Sent to restaurant',
        OrderStatus.kitchen => 'Preparing',
        OrderStatus.ready => 'Waiting for rider',
        OrderStatus.onTheWay => 'On the way',
        OrderStatus.delivered => 'Delivered',
        OrderStatus.cancelled => 'Cancelled',
      };

  bool get inFlight =>
      this == OrderStatus.placed ||
      this == OrderStatus.kitchen ||
      this == OrderStatus.ready ||
      this == OrderStatus.onTheWay;

  bool get customerCanCancel =>
      this == OrderStatus.placed || this == OrderStatus.kitchen;

  /// Position on the 5-step tracker (cancelled sits at 0).
  int get step => switch (this) {
        OrderStatus.placed || OrderStatus.cancelled => 0,
        OrderStatus.kitchen => 1,
        OrderStatus.ready => 2,
        OrderStatus.onTheWay => 3,
        OrderStatus.delivered => 4,
      };
}

class OrderLine {
  const OrderLine({
    required this.itemId,
    required this.name,
    required this.qty,
    required this.price,
    this.veg,
    this.addons = const [],
    this.customised = false,
  });
  final String itemId;
  final String name;
  final int qty;
  final int price;

  /// Null = unknown (dish gone from the menu). Never assume veg.
  final bool? veg;

  /// Add-ons chosen with the dish (0062); its size is already in [name].
  final List<String> addons;

  /// Ordered with a size or add-ons, so a reorder can't repeat it blind.
  final bool customised;
}

class Order {
  const Order({
    required this.id,
    required this.status,
    required this.restaurantSlug,
    required this.restaurantName,
    required this.restaurantImage,
    required this.restaurantAccent,
    required this.createdAt,
    required this.lines,
    required this.subtotal,
    required this.deliveryFee,
    required this.tax,
    required this.tip,
    required this.discount,
    required this.couponCode,
    required this.total,
    required this.paymentMethod,
    required this.paymentStatus,
    required this.cancelledBy,
    required this.cancellationReason,
    required this.address,
    required this.etaMin,
  });

  final String id;
  final OrderStatus status;
  final String restaurantSlug;
  final String restaurantName;
  final String? restaurantImage;
  final String? restaurantAccent;
  final DateTime? createdAt;
  final List<OrderLine> lines;
  final int subtotal;
  final int deliveryFee;
  final int tax;
  final int tip;
  final int discount;
  final String? couponCode;
  final int total;
  final String paymentMethod;
  final String paymentStatus;
  final String? cancelledBy;
  final String? cancellationReason;
  final String address;
  final int? etaMin;

  /// `shortOrderId` in order-map.ts.
  String get shortId => id.length <= 12 ? id : id.substring(0, 8).toUpperCase();

  static int _i(Object? v) => v is num ? v.round() : int.tryParse('$v') ?? 0;

  static String _addressText(Object? a) {
    if (a is Map) {
      final line = a['line'] ?? '';
      final label = a['label'];
      return label == null ? '$line' : '$label · $line';
    }
    return a == null ? '' : '$a';
  }

  factory Order.fromRow(Map<String, dynamic> r) {
    final rest = (r['restaurants'] as Map?) ?? const {};
    final items = (r['order_items'] as List?) ?? const [];
    final lines = [
      for (final raw in items)
        () {
          final it = Map<String, dynamic>.from(raw as Map);
          final mi = it['menu_items'] as Map?;
          return OrderLine(
            itemId: '${mi?['external_id'] ?? ''}',
            name: '${it['name'] ?? ''}',
            qty: _i(it['qty']),
            price: _i(it['price']),
            veg: mi?['veg'] as bool?,
            addons: chosenAddons(it['options']),
            customised: it['options'] != null,
          );
        }(),
    ];
    return Order(
      id: '${r['id']}',
      status: parseStatus(r['status']),
      restaurantSlug: '${rest['slug'] ?? ''}',
      restaurantName: '${rest['name'] ?? 'Restaurant'}',
      restaurantImage: rest['image_url'] as String?,
      restaurantAccent: rest['accent_tint'] as String?,
      createdAt: DateTime.tryParse('${r['created_at']}'),
      lines: lines,
      subtotal: lines.fold(0, (s, l) => s + l.qty * l.price),
      deliveryFee: _i(r['delivery_fee']),
      tax: _i(r['tax_amount']),
      tip: _i(r['tip']),
      discount: _i(r['discount']),
      couponCode: r['coupon_code'] as String?,
      total: _i(r['total']),
      paymentMethod: '${r['payment_method'] ?? 'cod'}',
      paymentStatus: '${r['payment_status'] ?? 'pending'}',
      cancelledBy: r['cancelled_by'] as String?,
      cancellationReason: r['cancellation_reason'] as String?,
      address: _addressText(r['address']),
      etaMin: rest['eta_min'] == null ? null : _i(rest['eta_min']),
    );
  }

  factory Order.fromUi(Map<String, dynamic> j) {
    final c = (j['charges'] as Map?) ?? const {};
    return Order(
      id: '${j['id']}',
      status: parseStatus('${j['status']}'.toLowerCase()),
      restaurantSlug: '${j['restaurantSlug'] ?? ''}',
      restaurantName: '${j['restaurantName'] ?? 'Restaurant'}',
      restaurantImage: j['restaurantImage'] as String?,
      restaurantAccent: j['restaurantAccent'] as String?,
      createdAt: DateTime.tryParse('${j['createdAt']}'),
      lines: [
        for (final raw in (j['lines'] as List?) ?? const [])
          OrderLine(
            itemId: '${(raw as Map)['itemId'] ?? ''}',
            name: '${raw['name'] ?? ''}',
            qty: _i(raw['qty']),
            price: _i(raw['price']),
            veg: raw['veg'] as bool?,
            addons: [for (final a in (raw['addons'] as List? ?? const [])) '$a'],
            customised: raw['customised'] == true,
          ),
      ],
      subtotal: _i(c['subtotal']),
      deliveryFee: _i(c['deliveryFee']),
      tax: _i(c['tax']),
      tip: _i(c['tip']),
      discount: _i(c['discount']),
      couponCode: c['couponCode'] as String?,
      total: _i(j['total']),
      paymentMethod: '${j['paymentMethod'] ?? 'cod'}',
      paymentStatus: '${j['paymentStatus'] ?? 'pending'}',
      cancelledBy: j['cancelledBy'] as String?,
      cancellationReason: j['cancellationReason'] as String?,
      address: _addressText(j['address']),
      etaMin: j['etaMinutes'] == null ? null : _i(j['etaMinutes']),
    );
  }

  /// The select `listMyOrders` uses (orders.ts). `pickup_otp`/`delivery_otp`
  /// are not granted — never select `*` from orders.
  static const columns =
      'id, restaurant_id, status, total, delivery_fee, tax_amount, tip, '
      'payment_method, payment_status, discount, coupon_code, cancelled_by, '
      'cancellation_reason, created_at, address, '
      'order_items(name, qty, price, menu_items(external_id, veg)), '
      'restaurants(slug, name, image_url, accent_tint, eta_min, eta_max)';

  /// [columns] plus each line's chosen size and add-ons (0062).
  static final columnsWithOptions = columns.replaceFirst('order_items(name, qty, price,', 'order_items(name, qty, price, options,');
}
