import 'package:flutter/foundation.dart';
import 'package:uuid/uuid.dart';

/// Orders as `/api/manager/orders*` sends them (Phase 3 plan, "API contract").
///
/// Every enum parses leniently: a value this build doesn't know becomes
/// `unknown` (or null where the field is nullable) rather than throwing, so a
/// server that grows a new status never takes the Orders tab down.

T _enumBy<T extends Enum>(List<T> values, String? wire, String Function(T) toWire, T unknown) {
  if (wire == null) return unknown;
  for (final v in values) {
    if (toWire(v) == wire) return v;
  }
  return unknown;
}

String _snake(String camel) => camel.replaceAllMapped(RegExp('[A-Z]'), (m) => '_${m[0]!.toLowerCase()}');

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;
int _int(Object? v) => v is num ? v.round() : 0;
double? _double(Object? v) => v is num ? v.toDouble() : null;
String? _str(Object? v) => v is String ? v : null;
Map<String, dynamic>? _map(Object? v) => v is Map ? v.cast<String, dynamic>() : null;
List<Map<String, dynamic>> _maps(Object? v) =>
    [for (final e in (v is List ? v : const [])) if (e is Map) e.cast<String, dynamic>()];

enum OrderStatus {
  placed,
  kitchen,
  ready,
  onTheWay,
  delivered,
  cancelled,
  unknown;

  String get wire => _snake(name);
  static OrderStatus parse(String? s) => _enumBy(values, s, (v) => v.wire, unknown);

  bool get isActive => this == placed || this == kitchen || this == ready || this == onTheWay;
  bool get isTerminal => this == delivered || this == cancelled;
}

enum DeliveryStatus {
  unassigned,
  assigned,
  pickedUp,
  delivered,
  failed,
  cancelled,
  unknown;

  String get wire => _snake(name);

  /// Null stays null (no delivery row); an unrecognised string is [unknown].
  static DeliveryStatus? parse(String? s) => s == null ? null : _enumBy(values, s, (v) => v.wire, unknown);
}

enum PaymentMethod {
  cod,
  online,
  unknown;

  static PaymentMethod? parse(String? s) => s == null ? null : _enumBy(values, s, (v) => v.name, unknown);
}

enum PaymentStatus {
  pending,
  paid,
  failed,
  refunded,
  unknown;

  static PaymentStatus? parse(String? s) => s == null ? null : _enumBy(values, s, (v) => v.name, unknown);
}

enum DelayKind {
  /// A placed order the kitchen has not accepted in time.
  accept,
  unassigned,
  delivery,
  pickup,
  prep,
  unknown;

  static DelayKind parse(String? s) => _enumBy(values, s, (v) => v.name, unknown);
}

enum CancelledBy {
  customer,
  vendor,
  manager,
  admin,
  system;

  static CancelledBy? parse(String? s) {
    for (final v in values) {
      if (v.name == s) return v;
    }
    return null;
  }
}

enum ActorRole {
  manager,
  admin,
  vendor,
  driver,
  customer,
  system,
  unknown;

  static ActorRole parse(String? s) => _enumBy(values, s, (v) => v.name, unknown);
}

enum TicketPriority {
  normal,
  high,
  emergency;

  static TicketPriority parse(String? s) => _enumBy(values, s, (v) => v.name, normal);
}

class VendorRef {
  const VendorRef({required this.id, required this.name});
  factory VendorRef.fromJson(Map<String, dynamic>? j) =>
      VendorRef(id: _str(j?['id']) ?? '', name: _str(j?['name']) ?? '');
  final String id;
  final String name;
}

class RiderRef {
  const RiderRef({required this.id, required this.name, this.code, this.phone});
  static RiderRef? fromJson(Map<String, dynamic>? j) => j == null
      ? null
      : RiderRef(id: _str(j['id']) ?? '', name: _str(j['name']) ?? '', code: _str(j['code']), phone: _str(j['phone']));
  final String id;
  final String name;

  /// `DR-0004`, or null before the Rider branch's 0081 ids exist.
  final String? code;

  /// Present only with `manager.call_customer` (detail's delivery block).
  final String? phone;
}

class Payment {
  const Payment({this.method, this.status});
  factory Payment.fromJson(Map<String, dynamic>? j) =>
      Payment(method: PaymentMethod.parse(_str(j?['method'])), status: PaymentStatus.parse(_str(j?['status'])));
  final PaymentMethod? method;
  final PaymentStatus? status;
}

class Eta {
  const Eta({this.pickupAt, this.expectedAt, this.dueAt, this.late = false, this.lateByMinutes = 0});
  static Eta? fromJson(Map<String, dynamic>? j) => j == null
      ? null
      : Eta(
          pickupAt: _date(j['pickupAt']),
          expectedAt: _date(j['expectedAt']),
          dueAt: _date(j['dueAt']),
          late: j['late'] == true,
          lateByMinutes: _int(j['lateByMinutes']),
        );
  final DateTime? pickupAt;
  final DateTime? expectedAt;
  final DateTime? dueAt;
  final bool late;
  final int lateByMinutes;
}

class Delay {
  const Delay({required this.kind, required this.minutes});
  static Delay? fromJson(Map<String, dynamic>? j) =>
      j == null ? null : Delay(kind: DelayKind.parse(_str(j['kind'])), minutes: _int(j['minutes']));
  final DelayKind kind;
  final int minutes;
}

class Cancellation {
  const Cancellation({this.by, this.reason, this.at});
  static Cancellation? fromJson(Map<String, dynamic>? j) => j == null
      ? null
      : Cancellation(by: CancelledBy.parse(_str(j['by'])), reason: _str(j['reason']), at: _date(j['at']));
  final CancelledBy? by;
  final String? reason;
  final DateTime? at;
}

/// One row of the Orders list (and the head of an order's detail).
class OrderListItem {
  const OrderListItem({
    required this.id,
    required this.code,
    required this.status,
    required this.createdAt,
    required this.zoneId,
    required this.vendor,
    this.customerName,
    required this.total,
    required this.itemCount,
    required this.payment,
    this.rider,
    this.deliveryStatus,
    this.byPhone = false,
    this.eta,
    this.delay,
    this.cancellation,
  });

  factory OrderListItem.fromJson(Map<String, dynamic> j) => OrderListItem(
        id: _str(j['id']) ?? '',
        code: _str(j['code']) ?? '',
        status: OrderStatus.parse(_str(j['status'])),
        createdAt: _date(j['createdAt']),
        zoneId: _str(j['zoneId']),
        vendor: VendorRef.fromJson(_map(j['vendor'])),
        customerName: _str(j['customerName']),
        total: _int(j['total']),
        itemCount: _int(j['itemCount']),
        payment: Payment.fromJson(_map(j['payment'])),
        rider: RiderRef.fromJson(_map(j['rider'])),
        deliveryStatus: DeliveryStatus.parse(_str(j['deliveryStatus'])),
        byPhone: j['byPhone'] == true,
        eta: Eta.fromJson(_map(j['eta'])),
        delay: Delay.fromJson(_map(j['delay'])),
        cancellation: Cancellation.fromJson(_map(j['cancellation'])),
      );

  final String id;
  final String code;
  final OrderStatus status;
  final DateTime? createdAt;
  final String? zoneId;
  final VendorRef vendor;
  final String? customerName;
  final int total;
  final int itemCount;
  final Payment payment;
  final RiderRef? rider;
  final DeliveryStatus? deliveryStatus;
  final bool byPhone;
  final Eta? eta;
  final Delay? delay;
  final Cancellation? cancellation;
}

class QueueCounts {
  const QueueCounts({this.delayed = 0, this.unassigned = 0});
  factory QueueCounts.fromJson(Map<String, dynamic>? j) =>
      QueueCounts(delayed: _int(j?['delayed']), unassigned: _int(j?['unassigned']));
  final int delayed;
  final int unassigned;
}

class OrderPage {
  const OrderPage({required this.items, this.nextCursor, this.counts = const QueueCounts()});
  factory OrderPage.fromJson(Map<String, dynamic> j) => OrderPage(
        items: [for (final m in _maps(j['items'])) OrderListItem.fromJson(m)],
        nextCursor: _str(j['nextCursor']),
        counts: QueueCounts.fromJson(_map(j['counts'])),
      );
  final List<OrderListItem> items;
  final String? nextCursor;
  final QueueCounts counts;
}

class OrderLine {
  const OrderLine({this.id, required this.name, required this.qty, required this.price, required this.lineTotal});
  factory OrderLine.fromJson(Map<String, dynamic> j) => OrderLine(
        id: _str(j['id']),
        name: _str(j['name']) ?? '',
        qty: _int(j['qty']),
        price: _int(j['price']),
        lineTotal: _int(j['lineTotal']),
      );
  /// `order_items.id`, for an item-unavailable correction. Not in the pinned
  /// contract's `items`; read when the server sends it, and the correction
  /// that needs it is offered only then.
  final String? id;
  final String name;
  final int qty;
  final int price;
  final int lineTotal;
}

class OrderMoney {
  const OrderMoney({this.subtotal = 0, this.discount = 0, this.deliveryFee = 0, this.tax = 0, this.tip = 0, this.total = 0});
  factory OrderMoney.fromJson(Map<String, dynamic>? j) => OrderMoney(
        subtotal: _int(j?['subtotal']),
        discount: _int(j?['discount']),
        deliveryFee: _int(j?['deliveryFee']),
        tax: _int(j?['tax']),
        tip: _int(j?['tip']),
        total: _int(j?['total']),
      );
  final int subtotal;
  final int discount;
  final int deliveryFee;
  final int tax;
  final int tip;
  final int total;
}

/// The shop (pickup) or the customer's address (drop).
class Place {
  const Place({this.name, this.label, this.address = '', this.landmark, this.note, this.lat, this.lng, this.phone});
  factory Place.fromJson(Map<String, dynamic>? j) => Place(
        name: _str(j?['name']),
        label: _str(j?['label']),
        address: _str(j?['address']) ?? '',
        landmark: _str(j?['landmark']),
        note: _str(j?['note']),
        lat: _double(j?['lat']),
        lng: _double(j?['lng']),
        phone: _str(j?['phone']),
      );
  final String? name;
  final String? label;
  final String address;
  final String? landmark;

  /// The drop only: the delivery note ops added for the rider.
  final String? note;
  final double? lat;
  final double? lng;
  final String? phone;

  bool get hasPoint => lat != null && lng != null;
}

class CustomerInfo {
  const CustomerInfo({this.name, this.phone});
  factory CustomerInfo.fromJson(Map<String, dynamic>? j) =>
      CustomerInfo(name: _str(j?['name']), phone: _str(j?['phone']));
  final String? name;

  /// The key is absent without `manager.call_customer`; then this is null and
  /// no Call button is drawn.
  final String? phone;
}

class LastFix {
  const LastFix({required this.lat, required this.lng, this.at, required this.ageSeconds});
  static LastFix? fromJson(Map<String, dynamic>? j) {
    final lat = _double(j?['lat']), lng = _double(j?['lng']);
    if (j == null || lat == null || lng == null) return null;
    return LastFix(lat: lat, lng: lng, at: _date(j['at']), ageSeconds: _int(j['ageSeconds']));
  }

  final double lat;
  final double lng;
  final DateTime? at;
  final int ageSeconds;
}

class DeliveryInfo {
  const DeliveryInfo({
    required this.id,
    this.status,
    this.rider,
    this.offeredTo,
    this.assignedAt,
    this.pickedUpAt,
    this.deliveredAt,
    this.failedAt,
    this.failureReason,
    this.lastFix,
  });
  static DeliveryInfo? fromJson(Map<String, dynamic>? j) => j == null
      ? null
      : DeliveryInfo(
          id: _str(j['id']) ?? '',
          status: DeliveryStatus.parse(_str(j['status'])),
          rider: RiderRef.fromJson(_map(j['rider'])),
          offeredTo: RiderRef.fromJson(_map(j['offeredTo'])),
          assignedAt: _date(j['assignedAt']),
          pickedUpAt: _date(j['pickedUpAt']),
          deliveredAt: _date(j['deliveredAt']),
          failedAt: _date(j['failedAt']),
          failureReason: _str(j['failureReason']),
          lastFix: LastFix.fromJson(_map(j['lastFix'])),
        );
  final String id;
  final DeliveryStatus? status;
  final RiderRef? rider;
  final RiderRef? offeredTo;
  final DateTime? assignedAt;
  final DateTime? pickedUpAt;
  final DateTime? deliveredAt;
  final DateTime? failedAt;
  final String? failureReason;
  final LastFix? lastFix;
}

class Actor {
  const Actor({required this.id, required this.name, required this.role});
  static Actor? fromJson(Map<String, dynamic>? j) => j == null
      ? null
      : Actor(id: _str(j['id']) ?? '', name: _str(j['name']) ?? '', role: ActorRole.parse(_str(j['role'])));
  final String id;
  final String name;
  final ActorRole role;
}

class TimelineEntry {
  const TimelineEntry({this.at, required this.source, required this.kind, this.from, this.to, this.actor, this.reason, this.method});
  factory TimelineEntry.fromJson(Map<String, dynamic> j) => TimelineEntry(
        at: _date(j['at']),
        source: _str(j['source']) ?? 'order',
        kind: _str(j['kind']) ?? '',
        from: _str(j['from']),
        to: _str(j['to']),
        actor: Actor.fromJson(_map(j['actor'])),
        reason: _str(j['reason']),
        method: _str(j['method']),
      );
  final DateTime? at;

  /// `order` | `delivery` | `ops`.
  final String source;

  /// `status`, `preparing`, `offered`, `accepted`, … `note`, `reassigned`,
  /// `corrected`, `escalated` — kept as the wire string; the timeline maps the
  /// ones it knows to words and shows the rest as they are.
  final String kind;
  final String? from;
  final String? to;
  final Actor? actor;
  final String? reason;
  final String? method;
}

class TicketRef {
  const TicketRef({required this.id, required this.number, this.status, this.priority});
  static TicketRef? fromJson(Map<String, dynamic>? j) => j == null
      ? null
      : TicketRef(
          id: _str(j['id']) ?? '',
          number: _int(j['number']),
          status: _str(j['status']),
          priority: _str(j['priority']) == null ? null : TicketPriority.parse(_str(j['priority'])),
        );
  final String id;
  final int number;
  final String? status;
  final TicketPriority? priority;
}

/// What this person may do to this order now — the server's answer, from the
/// order's state and their permissions. The app draws only these.
class AllowedActions {
  const AllowedActions({
    this.advance,
    this.cancel = false,
    this.assign = false,
    this.reassign = false,
    this.escalate = false,
    this.correct = false,
    this.note = false,
  });
  factory AllowedActions.fromJson(Map<String, dynamic>? j) {
    final adv = _str(j?['advance']);
    final parsed = adv == null ? null : OrderStatus.parse(adv);
    return AllowedActions(
      advance: parsed == OrderStatus.unknown ? null : parsed,
      cancel: j?['cancel'] == true,
      assign: j?['assign'] == true,
      reassign: j?['reassign'] == true,
      escalate: j?['escalate'] == true,
      correct: j?['correct'] == true,
      note: j?['note'] == true,
    );
  }
  final OrderStatus? advance;
  final bool cancel;
  final bool assign;
  final bool reassign;
  final bool escalate;
  final bool correct;
  final bool note;

  bool get any => advance != null || cancel || assign || reassign || escalate || correct || note;
}

class OrderDetail {
  const OrderDetail({
    required this.summary,
    this.items = const [],
    this.money = const OrderMoney(),
    this.pickup = const Place(),
    this.drop = const Place(),
    this.customer = const CustomerInfo(),
    this.delivery,
    this.timeline = const [],
    this.tickets = const [],
    this.allowed = const AllowedActions(),
  });

  factory OrderDetail.fromJson(Map<String, dynamic> j) => OrderDetail(
        summary: OrderListItem.fromJson(j),
        items: [for (final m in _maps(j['items'])) OrderLine.fromJson(m)],
        money: OrderMoney.fromJson(_map(j['money'])),
        pickup: Place.fromJson(_map(j['pickup'])),
        drop: Place.fromJson(_map(j['drop'])),
        customer: CustomerInfo.fromJson(_map(j['customer'])),
        delivery: DeliveryInfo.fromJson(_map(j['delivery'])),
        timeline: [for (final m in _maps(j['timeline'])) TimelineEntry.fromJson(m)],
        tickets: [for (final m in _maps(j['tickets'])) ?TicketRef.fromJson(m)],
        allowed: AllowedActions.fromJson(_map(j['allowed'])),
      );

  /// The list-row fields (id, code, status, vendor, rider, eta, delay, …).
  final OrderListItem summary;
  final List<OrderLine> items;
  final OrderMoney money;
  final Place pickup;
  final Place drop;
  final CustomerInfo customer;
  final DeliveryInfo? delivery;

  /// Oldest first.
  final List<TimelineEntry> timeline;
  final List<TicketRef> tickets;
  final AllowedActions allowed;

  String get id => summary.id;
}

enum IneligibleReason {
  offline,
  onBreak,
  staleFix,
  suspended,
  outOfZone,
  currentRider,
  unknown;

  String get wire => _snake(name);
  static IneligibleReason? parse(String? s) => s == null ? null : _enumBy(values, s, (v) => v.wire, unknown);
}

/// The reasons a manager may put a rider on anyway, with a reason the server
/// records (src/lib/dispatch/eligibility.ts canOverride): things they can see
/// past from where they stand. Never another zone, a suspension, or the
/// rider already on it.
bool canOverride(IneligibleReason? r) =>
    r == IneligibleReason.offline || r == IneligibleReason.onBreak || r == IneligibleReason.staleFix;

class RiderCandidate {
  const RiderCandidate({
    required this.id,
    required this.name,
    this.code,
    required this.phase,
    this.activeDeliveries = 0,
    this.distanceKm,
    this.lastFixAgeSeconds,
    required this.eligible,
    this.ineligibleReason,
  });
  factory RiderCandidate.fromJson(Map<String, dynamic> j) => RiderCandidate(
        id: _str(j['id']) ?? '',
        name: _str(j['name']) ?? '',
        code: _str(j['code']),
        phase: _str(j['phase']) ?? 'offline',
        activeDeliveries: _int(j['activeDeliveries']),
        distanceKm: _double(j['distanceKm']),
        lastFixAgeSeconds: j['lastFixAgeSeconds'] is num ? _int(j['lastFixAgeSeconds']) : null,
        eligible: j['eligible'] == true,
        ineligibleReason: IneligibleReason.parse(_str(j['ineligibleReason'])),
      );
  final String id;
  final String name;
  final String? code;

  /// `online` | `break` | `stale` | `offline`.
  final String phase;
  final int activeDeliveries;
  final double? distanceKm;
  final int? lastFixAgeSeconds;
  final bool eligible;
  final IneligibleReason? ineligibleReason;
}

List<RiderCandidate> parseRiderCandidates(Map<String, dynamic> j) =>
    [for (final m in _maps(j['riders'])) RiderCandidate.fromJson(m)];

/// The Orders tab's queues (`queue=` on the list route).
enum OrderQueue {
  delayed,
  unassigned,
  cancelled;

  static OrderQueue? parse(String? s) {
    for (final v in values) {
      if (v.name == s) return v;
    }
    return null;
  }
}

/// The India Standard Time offset — Deligro's "today" (design: period
/// attribution in IST).
const istOffset = Duration(hours: 5, minutes: 30);

/// The IST calendar day containing [now], as UTC instants `[from, to)`.
(DateTime, DateTime) istDayBounds(DateTime now) {
  final ist = now.toUtc().add(istOffset);
  final from = DateTime.utc(ist.year, ist.month, ist.day).subtract(istOffset);
  return (from, from.add(const Duration(days: 1)));
}

/// What the Orders list is filtered to. Immutable; the screen holds one and
/// replaces it.
@immutable
class OrderFilters {
  const OrderFilters({
    this.q,
    this.from,
    this.to,
    this.vendorId,
    this.vendorName,
    this.riderId,
    this.riderName,
    this.statuses = const {},
    this.payments = const {},
    this.zoneId,
    this.queue,
  });

  final String? q;
  final DateTime? from;
  final DateTime? to;
  final String? vendorId;

  /// Display only (the chip label); never sent.
  final String? vendorName;
  final String? riderId;

  /// Display only.
  final String? riderName;

  /// Database statuses (`placed`, `kitchen`, …).
  final Set<String> statuses;

  /// Payment method and status values (`cod`, `online`, `pending`, …).
  final Set<String> payments;
  final String? zoneId;
  final OrderQueue? queue;

  static const pendingStatuses = {'placed', 'kitchen', 'ready', 'on_the_way'};

  /// Reads a `/orders?…` link — the dashboard's tiles and pushes — including
  /// the aliases `status=today|pending|completed|cancelled`.
  factory OrderFilters.fromUri(Uri uri, {DateTime? now}) {
    final p = uri.queryParameters;
    Set<String> list(String key) =>
        {for (final s in (p[key] ?? '').split(',')) if (s.trim().isNotEmpty) s.trim()};
    var statuses = list('status');
    var queue = OrderQueue.parse(p['queue']);
    var from = _date(p['from']), to = _date(p['to']);
    if (statuses.remove('today')) {
      final (f, t) = istDayBounds(now ?? DateTime.now());
      from = f;
      to = t;
    }
    if (statuses.remove('pending')) statuses = {...statuses, ...pendingStatuses};
    if (statuses.remove('completed')) statuses = {...statuses, 'delivered'};
    if (statuses.length == 1 && statuses.first == 'cancelled' && queue == null) {
      statuses = {};
      queue = OrderQueue.cancelled;
    }
    String? s(String key) => (p[key]?.trim().isEmpty ?? true) ? null : p[key]!.trim();
    return OrderFilters(
      q: s('q'),
      from: from,
      to: to,
      vendorId: s('vendor'),
      riderId: s('rider'),
      statuses: statuses,
      payments: list('payment'),
      zoneId: s('zone'),
      queue: queue,
    );
  }

  /// The list route's query (contract: `q`, `from`, `to`, `vendor`, `rider`,
  /// `status`, `payment`, `zone`, `queue`). Empty values are left out.
  Map<String, String> toQuery() => {
        if (q != null && q!.isNotEmpty) 'q': q!,
        if (from != null) 'from': from!.toUtc().toIso8601String(),
        if (to != null) 'to': to!.toUtc().toIso8601String(),
        'vendor': ?vendorId,
        'rider': ?riderId,
        if (statuses.isNotEmpty) 'status': (statuses.toList()..sort()).join(','),
        if (payments.isNotEmpty) 'payment': (payments.toList()..sort()).join(','),
        'zone': ?zoneId,
        if (queue != null) 'queue': queue!.name,
      };

  /// True when anything narrows the list (so an empty result is "nothing
  /// matches", not "no orders").
  bool get narrowed =>
      (q?.isNotEmpty ?? false) ||
      from != null ||
      to != null ||
      vendorId != null ||
      riderId != null ||
      statuses.isNotEmpty ||
      payments.isNotEmpty ||
      queue != null;

  static const _unset = Object();

  OrderFilters copyWith({
    Object? q = _unset,
    Object? from = _unset,
    Object? to = _unset,
    Object? vendorId = _unset,
    Object? vendorName = _unset,
    Object? riderId = _unset,
    Object? riderName = _unset,
    Set<String>? statuses,
    Set<String>? payments,
    Object? zoneId = _unset,
    Object? queue = _unset,
  }) =>
      OrderFilters(
        q: identical(q, _unset) ? this.q : q as String?,
        from: identical(from, _unset) ? this.from : from as DateTime?,
        to: identical(to, _unset) ? this.to : to as DateTime?,
        vendorId: identical(vendorId, _unset) ? this.vendorId : vendorId as String?,
        vendorName: identical(vendorName, _unset) ? this.vendorName : vendorName as String?,
        riderId: identical(riderId, _unset) ? this.riderId : riderId as String?,
        riderName: identical(riderName, _unset) ? this.riderName : riderName as String?,
        statuses: statuses ?? this.statuses,
        payments: payments ?? this.payments,
        zoneId: identical(zoneId, _unset) ? this.zoneId : zoneId as String?,
        queue: identical(queue, _unset) ? this.queue : queue as OrderQueue?,
      );

  @override
  bool operator ==(Object other) =>
      other is OrderFilters &&
      other.q == q &&
      other.from == from &&
      other.to == to &&
      other.vendorId == vendorId &&
      other.riderId == riderId &&
      setEquals(other.statuses, statuses) &&
      setEquals(other.payments, payments) &&
      other.zoneId == zoneId &&
      other.queue == queue;

  @override
  int get hashCode => Object.hash(q, from, to, vendorId, riderId, Object.hashAllUnordered(statuses),
      Object.hashAllUnordered(payments), zoneId, queue);
}

const _uuid = Uuid();

enum CorrectionKind {
  status,
  deliveryStatus,
  itemUnavailable,

  /// A delivery note for the rider (gate code, a landmark given by phone).
  addressNote;

  String get wire => _snake(name);
}

/// One intervention on an order. The [clientActionId] is minted once, when the
/// manager decides to act, and reused by every retry of that decision — the
/// server treats it as an idempotency key, so a timeout-then-retry can never
/// apply the change twice.
sealed class OrderAction {
  OrderAction({this.reason, String? clientActionId}) : clientActionId = clientActionId ?? _uuid.v4();

  final String? reason;
  final String clientActionId;

  String get wire;
  Map<String, dynamic> get extra => const {};

  Map<String, dynamic> toJson() => {
        'action': wire,
        ...extra,
        if (reason != null && reason!.trim().isNotEmpty) 'reason': reason!.trim(),
        'clientActionId': clientActionId,
      };
}

/// Every status change a manager makes carries a reason (the server refuses
/// one without); [ReasonPicks.advance] offers the four quick ones.
class Advance extends OrderAction {
  Advance({required this.expected, required String super.reason, super.clientActionId});
  final OrderStatus expected;
  @override
  String get wire => 'advance';
  @override
  Map<String, dynamic> get extra => {'expected': expected.wire};
}

class Cancel extends OrderAction {
  Cancel({required String super.reason, super.clientActionId});
  @override
  String get wire => 'cancel';
}

/// [override]: put on a rider the picker marks offline, on a break or with
/// no recent location ([canOverride]); the server needs a reason for it and
/// records it as an override.
class Assign extends OrderAction {
  Assign({required this.riderId, bool override = false, super.reason, super.clientActionId}) : isOverride = override;
  final String riderId;
  final bool isOverride;
  @override
  String get wire => 'assign';
  @override
  Map<String, dynamic> get extra => {'riderId': riderId, 'afterPickup': false, if (isOverride) 'override': true};
}

class Reassign extends OrderAction {
  Reassign({required this.riderId, this.afterPickup = false, bool override = false, required String super.reason, super.clientActionId})
      : isOverride = override;
  final String riderId;
  final bool afterPickup;
  final bool isOverride;
  @override
  String get wire => 'reassign';
  @override
  Map<String, dynamic> get extra => {'riderId': riderId, 'afterPickup': afterPickup, if (isOverride) 'override': true};
}

class Escalate extends OrderAction {
  Escalate({this.priority = TicketPriority.high, required String super.reason, super.clientActionId});
  final TicketPriority priority;
  @override
  String get wire => 'escalate';
  @override
  Map<String, dynamic> get extra => {'priority': priority.name};
}

class Correct extends OrderAction {
  Correct({required this.kind, this.toStatus, this.itemId, this.note, required String super.reason, super.clientActionId});
  final CorrectionKind kind;
  final String? toStatus;

  /// `order_items.id` for `item_unavailable`.
  final String? itemId;

  /// The note for `address_note`.
  final String? note;
  @override
  String get wire => 'correct';
  @override
  Map<String, dynamic> get extra => {
        'kind': kind.wire,
        if (toStatus != null) 'toStatus': toStatus,
        if (itemId != null) 'itemId': itemId,
        if (note != null) 'note': note!.trim(),
      };
}

/// An ops note. The text travels as `note`; the contract does not use
/// `reason` for notes.
class Note extends OrderAction {
  Note({required this.text, super.clientActionId});
  final String text;
  @override
  String get wire => 'note';
  @override
  Map<String, dynamic> get extra => {'note': text.trim()};
}

/// What came back from an action.
sealed class ActionOutcome {
  const ActionOutcome();
}

class ActionDone extends ActionOutcome {
  const ActionDone(this.order, {this.ticket});

  /// The order after the change — null when the change went through but the
  /// server could not re-read the order (`{ok: true, order: null}`); the
  /// caller then fetches it.
  final OrderDetail? order;

  /// Set for `escalate`.
  final TicketRef? ticket;
}

/// The server said no, for a reason the manager can read (409 / 400 / 403 /
/// 404 / 429 codes from the contract).
class ActionRefused extends ActionOutcome {
  const ActionRefused(this.code, [this.reasons = const [], this.field]);
  final String code;
  final List<String> reasons;

  /// For a 400: the request field the server rejected (`reason`, `note`,
  /// `riderId`, …), so the app can point at it.
  final String? field;
}
