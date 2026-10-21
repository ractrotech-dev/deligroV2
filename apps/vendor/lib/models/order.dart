/// The client's six order statuses. Mirrors src/lib/orders/kitchen-stage.ts:
/// the database's `kitchen` splits into accepted / preparing by
/// `preparing_at` (0061); `on_the_way` and `delivered` are both "completed"
/// from the kitchen's side.
enum OrderStage {
  newOrder('new'),
  accepted('accepted'),
  preparing('preparing'),
  ready('ready'),
  completed('completed'),
  cancelled('cancelled');

  const OrderStage(this.wire);
  final String wire;

  static OrderStage? fromWire(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return null;
  }

  static OrderStage? fromStatus(String status, {String? preparingAt}) => switch (status) {
    'placed' => OrderStage.newOrder,
    'kitchen' => preparingAt != null && preparingAt.isNotEmpty ? OrderStage.preparing : OrderStage.accepted,
    'ready' => OrderStage.ready,
    'on_the_way' || 'delivered' => OrderStage.completed,
    'cancelled' => OrderStage.cancelled,
    _ => null,
  };

  bool get active => this == newOrder || this == accepted || this == preparing || this == ready;
}

class OrderLine {
  const OrderLine({
    required this.name,
    required this.qty,
    required this.price,
    this.description,
    this.imageUrl,
    this.addons = const [],
  });

  factory OrderLine.fromJson(Map<String, dynamic> j) => OrderLine(
    name: '${j['name'] ?? ''}',
    qty: (j['qty'] as num?)?.toInt() ?? 0,
    price: (j['price'] as num?)?.toInt() ?? 0,
    description: j['description'] as String?,
    imageUrl: j['imageUrl'] as String?,
    addons: [for (final a in (j['addons'] as List? ?? const [])) '$a'],
  );

  final String name;
  final int qty;

  /// Unit price snapshot, whole rupees.
  final int price;
  final String? description;
  final String? imageUrl;

  /// Add-ons the customer chose; the size is already part of [name].
  final List<String> addons;

  int get amount => qty * price;
}

/// One step of the status history (0061 `order_status_events`).
class OrderEvent {
  const OrderEvent({required this.kind, this.from, this.to, required this.by, this.reason, required this.at});

  factory OrderEvent.fromJson(Map<String, dynamic> j) => OrderEvent(
    kind: '${j['kind'] ?? 'status'}',
    from: j['from'] as String?,
    to: j['to'] as String?,
    by: '${j['by'] ?? 'deligro'}',
    reason: j['reason'] as String?,
    at: DateTime.tryParse('${j['at']}')?.toLocal() ?? DateTime.now(),
  );

  /// `status` or `preparing`.
  final String kind;
  final String? from;
  final String? to;

  /// `you`, `customer` or `deligro`.
  final String by;
  final String? reason;
  final DateTime at;
}

class VendorOrder {
  const VendorOrder({
    required this.id,
    required this.code,
    required this.status,
    required this.stage,
    required this.createdAt,
    required this.customerName,
    this.customerPhone,
    required this.area,
    this.deliveryLine,
    required this.lines,
    required this.total,
    required this.itemsSubtotal,
    required this.deliveryFee,
    required this.taxAmount,
    required this.tip,
    required this.discount,
    this.couponCode,
    this.discountFundedBy,
    this.paymentMethod,
    this.paymentStatus,
    this.acceptedAt,
    this.preparingAt,
    this.readyAt,
    this.prepMinutes,
    this.pickupOtp,
    this.riderName,
    this.riderStage,
    this.cancellationReason,
    this.channel,
    this.events = const [],
  });

  factory VendorOrder.fromJson(Map<String, dynamic> j) {
    final status = '${j['status'] ?? ''}';
    final preparingAt = j['preparingAt'] as String?;
    final customer = (j['customerProfile'] as Map?)?.cast<String, dynamic>();
    final rider = (j['rider'] as Map?)?.cast<String, dynamic>();
    int money(String k) => (j[k] as num?)?.round() ?? 0;
    DateTime? time(String k) => j[k] == null ? null : DateTime.tryParse('${j[k]}')?.toLocal();
    return VendorOrder(
      id: '${j['id']}',
      code: '${j['code'] ?? ''}',
      status: status,
      stage:
          OrderStage.fromWire(j['stage'] as String?) ??
          OrderStage.fromStatus(status, preparingAt: preparingAt) ??
          OrderStage.newOrder,
      createdAt: time('createdAt') ?? DateTime.now(),
      customerName: '${customer?['name'] ?? j['customer'] ?? 'Customer'}',
      customerPhone: customer?['phone'] as String?,
      area: '${j['area'] ?? ''}',
      deliveryLine: j['deliveryLine'] as String?,
      lines: [
        for (final l in (j['lines'] as List? ?? const [])) OrderLine.fromJson((l as Map).cast<String, dynamic>()),
      ],
      total: money('total'),
      itemsSubtotal: money('itemsSubtotal'),
      deliveryFee: money('deliveryFee'),
      taxAmount: money('taxAmount'),
      tip: money('tip'),
      discount: money('discount'),
      couponCode: j['couponCode'] as String?,
      discountFundedBy: j['discountFundedBy'] as String?,
      paymentMethod: j['paymentMethod'] as String?,
      paymentStatus: j['paymentStatus'] as String?,
      acceptedAt: time('acceptedAt'),
      preparingAt: time('preparingAt'),
      readyAt: time('readyAt'),
      prepMinutes: (j['prepMinutes'] as num?)?.toInt(),
      pickupOtp: j['pickupOtp'] as String?,
      riderName: rider?['name'] as String?,
      riderStage: rider?['stage'] as String?,
      cancellationReason: j['cancellationReason'] as String?,
      channel: j['channel'] as String?,
      events: [
        for (final e in (j['events'] as List? ?? const [])) OrderEvent.fromJson((e as Map).cast<String, dynamic>()),
      ],
    );
  }

  final String id;

  /// Short human reference, e.g. `#D-4821`.
  final String code;
  final String status;
  final OrderStage stage;
  final DateTime createdAt;
  final String customerName;

  /// Only while the order is active (requirements §15.8).
  final String? customerPhone;
  final String area;
  final String? deliveryLine;
  final List<OrderLine> lines;
  final int total;
  final int itemsSubtotal;
  final int deliveryFee;
  final int taxAmount;
  final int tip;
  final int discount;
  final String? couponCode;

  /// `platform` (Deligro) or `vendor`.
  final String? discountFundedBy;

  /// `cod` or `online`; null on a database that predates 0025.
  final String? paymentMethod;

  /// `pending`, `authorized`, `paid`, `failed`, `refunded`.
  final String? paymentStatus;
  final DateTime? acceptedAt;
  final DateTime? preparingAt;
  final DateTime? readyAt;
  final int? prepMinutes;
  final String? pickupOtp;
  final String? riderName;

  /// `assigned` (on the way to the shop) or `picked_up`.
  final String? riderStage;
  final String? cancellationReason;
  final String? channel;
  final List<OrderEvent> events;

  int get itemCount => lines.fold(0, (n, l) => n + l.qty);

  bool get isCod => paymentMethod == 'cod';

  /// The order ID without the `#`, for search.
  String get shortId => code.replaceFirst('#', '');

  /// When the promised prep time runs out, once accepted with one.
  DateTime? get dueAt =>
      acceptedAt != null && prepMinutes != null ? acceptedAt!.add(Duration(minutes: prepMinutes!)) : null;

  bool matches(String query) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return true;
    return shortId.toLowerCase().contains(q.replaceFirst('#', '')) || customerName.toLowerCase().contains(q);
  }
}
