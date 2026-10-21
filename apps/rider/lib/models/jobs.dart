// The rider's job data, as `GET /api/rider/board` sends it (RiderBoard and its
// parts in src/lib/data-access/rider-jobs.ts). Keys are camelCase, instants are
// ISO strings. Every model also writes itself back to the same JSON, which is
// how the active delivery is cached for a rider who loses signal.

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;

double? _double(Object? v) => v is num ? v.toDouble() : null;

int? _int(Object? v) => v is num ? v.toInt() : null;

Map<String, dynamic> _map(Object? v) =>
    v is Map ? Map<String, dynamic>.from(v) : throw FormatException('expected an object, got ${v.runtimeType}');

List<Map<String, dynamic>> _list(Object? v) =>
    v == null ? const [] : (v as List).map(_map).toList(growable: false);

typedef LatLngPoint = ({double lat, double lng});

LatLngPoint? _point(Object? v) {
  if (v is! Map) return null;
  final lat = _double(v['lat']);
  final lng = _double(v['lng']);
  return lat == null || lng == null ? null : (lat: lat, lng: lng);
}

/// Where a rider is sent: the shop or the drop. The customer's and the shop's
/// numbers are only ever present on the active delivery.
class RiderStop {
  const RiderStop({required this.name, this.line, this.point, this.phone});

  final String name;
  final String? line;
  final LatLngPoint? point;
  final String? phone;

  factory RiderStop.fromJson(Map<String, dynamic> j) => RiderStop(
        name: '${j['name'] ?? ''}',
        line: j['line'] as String?,
        point: _point(j['point']),
        phone: j['phone'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'name': name,
        'line': line,
        'point': point == null ? null : {'lat': point!.lat, 'lng': point!.lng},
        'phone': phone,
      };
}

/// The drop on the active delivery, which also names the person receiving.
class RiderDrop extends RiderStop {
  const RiderDrop({required super.name, super.line, super.point, super.phone, this.customerName});

  final String? customerName;

  factory RiderDrop.fromJson(Map<String, dynamic> j) => RiderDrop(
        name: '${j['name'] ?? ''}',
        line: j['line'] as String?,
        point: _point(j['point']),
        phone: j['phone'] as String?,
        customerName: j['customerName'] as String?,
      );

  @override
  Map<String, dynamic> toJson() => {...super.toJson(), 'customerName': customerName};
}

/// What the rider does about money at the door.
enum CashInstruction {
  collect,
  prepaid,

  /// The server could not tell. Also what an instruction this app does not
  /// know parses to: never "collect", so the screen cannot invent a demand.
  unconfirmed;

  static CashInstruction parse(Object? v) => switch (v) {
        'collect' => collect,
        'prepaid' => prepaid,
        _ => unconfirmed,
      };
}

class RiderPayment {
  const RiderPayment({required this.instruction, this.collectAmount = 0});

  final CashInstruction instruction;

  /// Rupees to take at the door; zero unless [instruction] is collect.
  final double collectAmount;

  factory RiderPayment.fromJson(Map<String, dynamic> j) {
    final instruction = CashInstruction.parse(j['instruction']);
    return RiderPayment(
      instruction: instruction,
      collectAmount: instruction == CashInstruction.collect ? (_double(j['collectAmount']) ?? 0) : 0,
    );
  }

  Map<String, dynamic> toJson() => {'instruction': instruction.name, 'collectAmount': collectAmount};
}

class RiderOffer {
  const RiderOffer({
    required this.orderId,
    required this.code,
    required this.shop,
    required this.drop,
    this.instructions,
    this.itemCount = 0,
    this.shopToDropKm,
    this.riderToShopKm,
    this.etaMinutes,
    this.offerExpiresAt,
    this.reservedForYou = false,
    required this.payment,
    this.estimatedEarning,
  });

  final String orderId;
  final String code;
  final RiderStop shop;
  final RiderStop drop;
  final String? instructions;
  final int itemCount;
  final double? shopToDropKm;
  final double? riderToShopKm;
  final int? etaMinutes;

  /// When the exclusive window ends; null for an order nobody is holding.
  final DateTime? offerExpiresAt;
  final bool reservedForYou;
  final RiderPayment payment;

  /// Null until the rate card exists (Phase 3).
  final double? estimatedEarning;

  factory RiderOffer.fromJson(Map<String, dynamic> j) => RiderOffer(
        orderId: j['orderId'] as String,
        code: '${j['code'] ?? ''}',
        shop: RiderStop.fromJson(_map(j['shop'])),
        drop: RiderStop.fromJson(_map(j['drop'])),
        instructions: j['instructions'] as String?,
        itemCount: _int(j['itemCount']) ?? 0,
        shopToDropKm: _double(j['shopToDropKm']),
        riderToShopKm: _double(j['riderToShopKm']),
        etaMinutes: _int(j['etaMinutes']),
        offerExpiresAt: _date(j['offerExpiresAt']),
        reservedForYou: j['reservedForYou'] == true,
        payment: RiderPayment.fromJson(_map(j['payment'])),
        estimatedEarning: _double(j['estimatedEarning']),
      );

  Map<String, dynamic> toJson() => {
        'orderId': orderId,
        'code': code,
        'shop': shop.toJson(),
        'drop': drop.toJson(),
        'instructions': instructions,
        'itemCount': itemCount,
        'shopToDropKm': shopToDropKm,
        'riderToShopKm': riderToShopKm,
        'etaMinutes': etaMinutes,
        'offerExpiresAt': offerExpiresAt?.toUtc().toIso8601String(),
        'reservedForYou': reservedForYou,
        'payment': payment.toJson(),
        'estimatedEarning': estimatedEarning,
      };
}

/// A pickup offered while the kitchen is still cooking.
class RiderUpcoming {
  const RiderUpcoming({required this.offer, this.readyInMinutes});

  final RiderOffer offer;
  final int? readyInMinutes;

  factory RiderUpcoming.fromJson(Map<String, dynamic> j) => RiderUpcoming(
        offer: RiderOffer.fromJson(_map(j['offer'])),
        readyInMinutes: _int(j['readyInMinutes']),
      );

  Map<String, dynamic> toJson() => {'offer': offer.toJson(), 'readyInMinutes': readyInMinutes};
}

/// The delivery's own status, in the order a delivery moves through them.
enum RiderDeliveryStatus {
  accepted('accepted'),
  arrivedPickup('arrived_pickup'),
  pickedUp('picked_up'),
  onTheWay('on_the_way'),
  arrivedDrop('arrived_drop'),
  delivered('delivered'),
  failed('failed'),
  cancelled('cancelled');

  const RiderDeliveryStatus(this.wire);

  final String wire;

  /// True while the rider is still carrying the job.
  bool get live => index <= arrivedDrop.index;

  /// An unknown status throws rather than guessing: showing the wrong buttons
  /// on a live delivery is worse than showing an error.
  static RiderDeliveryStatus parse(Object? v) => values.firstWhere(
        (s) => s.wire == v,
        orElse: () => throw FormatException('unknown delivery status: $v'),
      );
}

class RiderEvent {
  const RiderEvent({required this.kind, this.method, this.reason, required this.at});

  final String kind;
  final String? method;
  final String? reason;
  final DateTime at;

  factory RiderEvent.fromJson(Map<String, dynamic> j) => RiderEvent(
        kind: '${j['kind']}',
        method: j['method'] as String?,
        reason: j['reason'] as String?,
        at: _date(j['at']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      );

  Map<String, dynamic> toJson() =>
      {'kind': kind, 'method': method, 'reason': reason, 'at': at.toUtc().toIso8601String()};
}

/// A request or report the rider raised on the delivery. [status] is
/// `pending`, `approved`, `rejected` or `acknowledged`.
class RiderException {
  const RiderException({
    required this.id,
    required this.kind,
    required this.status,
    required this.reason,
    this.decisionNote,
    required this.createdAt,
  });

  final String id;
  final String kind;
  final String status;
  final String reason;
  final String? decisionNote;
  final DateTime createdAt;

  bool get pending => status == 'pending';

  factory RiderException.fromJson(Map<String, dynamic> j) => RiderException(
        id: '${j['id']}',
        kind: '${j['kind']}',
        status: '${j['status']}',
        reason: '${j['reason'] ?? ''}',
        decisionNote: j['decisionNote'] as String?,
        createdAt: _date(j['createdAt']) ?? DateTime.fromMillisecondsSinceEpoch(0, isUtc: true),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'kind': kind,
        'status': status,
        'reason': reason,
        'decisionNote': decisionNote,
        'createdAt': createdAt.toUtc().toIso8601String(),
      };
}

class RiderItem {
  const RiderItem({required this.name, required this.qty});

  final String name;
  final int qty;

  factory RiderItem.fromJson(Map<String, dynamic> j) =>
      RiderItem(name: '${j['name']}', qty: _int(j['qty']) ?? 1);

  Map<String, dynamic> toJson() => {'name': name, 'qty': qty};
}

/// The delivery the rider is carrying.
class RiderActive {
  const RiderActive({
    required this.orderId,
    required this.deliveryId,
    required this.code,
    required this.status,
    required this.shop,
    required this.drop,
    this.instructions,
    this.items = const [],
    required this.payment,
    this.pickupCodeRequired = false,
    this.distanceKm,
    this.etaMinutes,
    this.podPhotoRequired = false,
    this.timeline = const [],
    this.exceptions = const [],
    this.arrivedDropAt,
    this.unreachableWaitMinutes = 10,
  });

  final String orderId;
  final String deliveryId;
  final String code;
  final RiderDeliveryStatus status;
  final RiderStop shop;
  final RiderDrop drop;
  final String? instructions;
  final List<RiderItem> items;
  final RiderPayment payment;
  final bool pickupCodeRequired;
  final double? distanceKm;
  final int? etaMinutes;
  final bool podPhotoRequired;
  final List<RiderEvent> timeline;
  final List<RiderException> exceptions;
  final DateTime? arrivedDropAt;

  /// Minutes the rider must wait at the drop before "customer unreachable".
  final int unreachableWaitMinutes;

  bool get hasPendingException => exceptions.any((e) => e.pending);

  factory RiderActive.fromJson(Map<String, dynamic> j) => RiderActive(
        orderId: j['orderId'] as String,
        deliveryId: '${j['deliveryId']}',
        code: '${j['code'] ?? ''}',
        status: RiderDeliveryStatus.parse(j['status']),
        shop: RiderStop.fromJson(_map(j['shop'])),
        drop: RiderDrop.fromJson(_map(j['drop'])),
        instructions: j['instructions'] as String?,
        items: _list(j['items']).map(RiderItem.fromJson).toList(growable: false),
        payment: RiderPayment.fromJson(_map(j['payment'])),
        pickupCodeRequired: j['pickupCodeRequired'] == true,
        distanceKm: _double(j['distanceKm']),
        etaMinutes: _int(j['etaMinutes']),
        podPhotoRequired: j['podPhotoRequired'] == true,
        timeline: _list(j['timeline']).map(RiderEvent.fromJson).toList(growable: false),
        exceptions: _list(j['exceptions']).map(RiderException.fromJson).toList(growable: false),
        arrivedDropAt: _date(j['arrivedDropAt']),
        unreachableWaitMinutes: _int(j['unreachableWaitMinutes']) ?? 10,
      );

  Map<String, dynamic> toJson() => {
        'orderId': orderId,
        'deliveryId': deliveryId,
        'code': code,
        'status': status.wire,
        'shop': shop.toJson(),
        'drop': drop.toJson(),
        'instructions': instructions,
        'items': items.map((i) => i.toJson()).toList(),
        'payment': payment.toJson(),
        'pickupCodeRequired': pickupCodeRequired,
        'distanceKm': distanceKm,
        'etaMinutes': etaMinutes,
        'podPhotoRequired': podPhotoRequired,
        'timeline': timeline.map((e) => e.toJson()).toList(),
        'exceptions': exceptions.map((e) => e.toJson()).toList(),
        'arrivedDropAt': arrivedDropAt?.toUtc().toIso8601String(),
        'unreachableWaitMinutes': unreachableWaitMinutes,
      };
}

class RiderBoard {
  const RiderBoard({
    this.offers = const [],
    this.upcoming = const [],
    this.active,
    this.offerWindowSeconds = 180,
    this.routingBaseUrl,
  });

  final List<RiderOffer> offers;
  final List<RiderUpcoming> upcoming;
  final RiderActive? active;
  final int offerWindowSeconds;

  /// `platform_settings.routing_base_url`, if the board sends it (it does not
  /// yet: the app then uses the default OSRM server). Only an https URL is
  /// taken.
  final String? routingBaseUrl;

  factory RiderBoard.fromJson(Map<String, dynamic> j) => RiderBoard(
        offers: _list(j['offers']).map(RiderOffer.fromJson).toList(growable: false),
        upcoming: _list(j['upcoming']).map(RiderUpcoming.fromJson).toList(growable: false),
        active: j['active'] == null ? null : RiderActive.fromJson(_map(j['active'])),
        offerWindowSeconds: _int(j['offerWindowSeconds']) ?? 180,
        routingBaseUrl: _https(j['routingBaseUrl']),
      );

  static String? _https(Object? v) {
    if (v is! String) return null;
    final uri = Uri.tryParse(v.trim());
    return uri != null && uri.scheme == 'https' && uri.host.isNotEmpty ? v.trim() : null;
  }

  Map<String, dynamic> toJson() => {
        'offers': offers.map((o) => o.toJson()).toList(),
        'upcoming': upcoming.map((u) => u.toJson()).toList(),
        'active': active?.toJson(),
        'offerWindowSeconds': offerWindowSeconds,
        'routingBaseUrl': routingBaseUrl,
      };
}
