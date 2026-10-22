import 'package:uuid/uuid.dart';

import 'json_util.dart';
import 'vendors.dart' show PersonRef;

/// Offers and promo codes (§9) — `/api/manager/offers*`.

const _uuid = Uuid();

/// `{ id, name }`, never null in a list.
PersonRef refOf(Object? v) => PersonRef.fromJson(v) ?? const PersonRef(id: '', name: '');
List<PersonRef> refsOf(Object? v) => [for (final m in jMaps(v)) refOf(m)];

enum OfferKind {
  percent,
  flat,
  unknown;

  static OfferKind parse(Object? v) => jEnum(values, v, unknown);
}

/// Who pays for the discount (existing settlement funding values).
enum OfferFunding {
  platform('Deligro'),
  vendor('Vendor'),
  unknown('—');

  const OfferFunding(this.label);
  final String label;
  static OfferFunding parse(Object? v) => jEnum(values, v, unknown);
}

enum OfferState {
  scheduled('Scheduled'),
  active('Active'),
  expired('Expired'),
  inactive('Inactive'),
  exhausted('Used up'),
  unknown('Unknown');

  const OfferState(this.label);
  final String label;
  static OfferState parse(Object? v) => jEnum(values, v, unknown);

  /// The list tabs, in order.
  static const tabs = [active, scheduled, expired, inactive, exhausted];
}

/// The terms of one offer — also the body for creating one.
class OfferTerms {
  const OfferTerms({
    required this.code,
    required this.kind,
    required this.value,
    this.label,
    this.minOrder = 0,
    this.maxDiscount,
    this.startsAt,
    this.expiresAt,
    this.maxPerCustomer,
    this.maxRedemptions,
    this.vendorIds = const [],
    this.zoneIds = const [],
    this.itemIds = const [],
    this.fundedBy = OfferFunding.platform,
    this.requestId,
  });

  factory OfferTerms.fromJson(Map<String, dynamic> j) => OfferTerms(
        code: jStrOr(j['code']),
        label: jStr(j['label']),
        kind: OfferKind.parse(j['kind']),
        value: jInt(j['value']),
        minOrder: jInt(j['minOrder']),
        maxDiscount: jIntOrNull(j['maxDiscount']),
        startsAt: jDate(j['startsAt']),
        expiresAt: jDate(j['expiresAt']),
        maxPerCustomer: jIntOrNull(j['maxPerCustomer']),
        maxRedemptions: jIntOrNull(j['maxRedemptions']),
        vendorIds: jStrings(j['vendorIds']),
        zoneIds: jStrings(j['zoneIds']),
        itemIds: jStrings(j['itemIds']),
        fundedBy: OfferFunding.parse(j['fundedBy']),
        requestId: jStr(j['requestId']),
      );

  final String code;
  final String? label;
  final OfferKind kind;
  final int value;
  final int minOrder;
  final int? maxDiscount;
  final DateTime? startsAt;
  final DateTime? expiresAt;
  final int? maxPerCustomer;
  final int? maxRedemptions;
  final List<String> vendorIds;
  final List<String> zoneIds;
  final List<String> itemIds;
  final OfferFunding fundedBy;
  final String? requestId;

  Map<String, dynamic> toJson() => {
        'code': code,
        'label': label,
        'kind': kind.name,
        'value': value,
        'minOrder': minOrder,
        'maxDiscount': maxDiscount,
        'startsAt': startsAt?.toUtc().toIso8601String(),
        'expiresAt': expiresAt?.toUtc().toIso8601String(),
        'maxPerCustomer': maxPerCustomer,
        'maxRedemptions': maxRedemptions,
        'vendorIds': vendorIds,
        'zoneIds': zoneIds,
        'itemIds': itemIds,
        'fundedBy': fundedBy == OfferFunding.unknown ? OfferFunding.platform.name : fundedBy.name,
        'requestId': requestId,
      };

  /// "₹50 off" / "10% off, up to ₹80".
  String get summary => describeOffer(kind, value, maxDiscount);
}

String describeOffer(OfferKind kind, int value, int? maxDiscount) => switch (kind) {
      OfferKind.percent => maxDiscount == null ? '$value% off' : '$value% off, up to ₹$maxDiscount',
      _ => '₹$value off',
    };

class OfferSummary {
  const OfferSummary({
    required this.code,
    required this.kind,
    required this.value,
    required this.state,
    required this.fundedBy,
    this.label,
    this.minOrder = 0,
    this.maxDiscount,
    this.active = false,
    this.startsAt,
    this.expiresAt,
    this.vendors = const [],
    this.zones = const [],
    this.itemCount = 0,
    this.redemptions = 0,
    this.maxRedemptions,
    this.discountGiven = 0,
    this.createdBy,
    this.updatedAt,
  });

  factory OfferSummary.fromJson(Map<String, dynamic> j) => OfferSummary(
        code: jStrOr(j['code']),
        label: jStr(j['label']),
        kind: OfferKind.parse(j['kind']),
        value: jInt(j['value']),
        minOrder: jInt(j['minOrder']),
        maxDiscount: jIntOrNull(j['maxDiscount']),
        state: OfferState.parse(j['state']),
        active: jBool(j['active']),
        startsAt: jDate(j['startsAt']),
        expiresAt: jDate(j['expiresAt']),
        fundedBy: OfferFunding.parse(j['fundedBy']),
        vendors: refsOf(j['vendors']),
        zones: refsOf(j['zones']),
        itemCount: jInt(j['itemCount']),
        redemptions: jInt(j['redemptions']),
        maxRedemptions: jIntOrNull(j['maxRedemptions']),
        discountGiven: jInt(j['discountGiven']),
        createdBy: PersonRef.fromJson(j['createdBy']),
        updatedAt: jDate(j['updatedAt']),
      );

  final String code;
  final String? label;
  final OfferKind kind;
  final int value;
  final int minOrder;
  final int? maxDiscount;
  final OfferState state;
  final bool active;
  final DateTime? startsAt;
  final DateTime? expiresAt;
  final OfferFunding fundedBy;
  final List<PersonRef> vendors;
  final List<PersonRef> zones;
  final int itemCount;
  final int redemptions;
  final int? maxRedemptions;
  final int discountGiven;
  final PersonRef? createdBy;
  final DateTime? updatedAt;

  /// No vendor and no zone: applies everywhere, which only an admin may change.
  bool get platformWide => vendors.isEmpty && zones.isEmpty;
  String get summary => describeOffer(kind, value, maxDiscount);
}

class OfferAllowed {
  const OfferAllowed({this.edit = false, this.activate = false, this.deactivate = false});
  factory OfferAllowed.fromJson(Map<String, dynamic>? j) =>
      OfferAllowed(edit: jBool(j?['edit']), activate: jBool(j?['activate']), deactivate: jBool(j?['deactivate']));
  final bool edit;
  final bool activate;
  final bool deactivate;
}

class OfferDetail extends OfferSummary {
  const OfferDetail({
    required super.code,
    required super.kind,
    required super.value,
    required super.state,
    required super.fundedBy,
    super.label,
    super.minOrder,
    super.maxDiscount,
    super.active,
    super.startsAt,
    super.expiresAt,
    super.vendors,
    super.zones,
    super.itemCount,
    super.redemptions,
    super.maxRedemptions,
    super.discountGiven,
    super.createdBy,
    super.updatedAt,
    this.maxPerCustomer,
    this.items = const [],
    this.requestId,
    this.campaignIds = const [],
    this.allowed = const OfferAllowed(),
  });

  factory OfferDetail.fromJson(Map<String, dynamic> j) {
    final s = OfferSummary.fromJson(j);
    return OfferDetail(
      code: s.code,
      label: s.label,
      kind: s.kind,
      value: s.value,
      minOrder: s.minOrder,
      maxDiscount: s.maxDiscount,
      state: s.state,
      active: s.active,
      startsAt: s.startsAt,
      expiresAt: s.expiresAt,
      fundedBy: s.fundedBy,
      vendors: s.vendors,
      zones: s.zones,
      itemCount: s.itemCount,
      redemptions: s.redemptions,
      maxRedemptions: s.maxRedemptions,
      discountGiven: s.discountGiven,
      createdBy: s.createdBy,
      updatedAt: s.updatedAt,
      maxPerCustomer: jIntOrNull(j['maxPerCustomer']),
      items: refsOf(j['items']),
      requestId: jStr(j['requestId']),
      campaignIds: jStrings(j['campaignIds']),
      allowed: OfferAllowed.fromJson(jMap(j['allowed'])),
    );
  }

  final int? maxPerCustomer;
  final List<PersonRef> items;
  final String? requestId;
  final List<String> campaignIds;
  final OfferAllowed allowed;

  /// These terms as an editable body.
  OfferTerms get terms => OfferTerms(
        code: code,
        label: label,
        kind: kind,
        value: value,
        minOrder: minOrder,
        maxDiscount: maxDiscount,
        startsAt: startsAt,
        expiresAt: expiresAt,
        maxPerCustomer: maxPerCustomer,
        maxRedemptions: maxRedemptions,
        vendorIds: [for (final v in vendors) v.id],
        zoneIds: [for (final z in zones) z.id],
        itemIds: [for (final i in items) i.id],
        fundedBy: fundedBy,
        requestId: requestId,
      );
}

class FunderSplit {
  const FunderSplit({this.vendor = 0, this.platform = 0});
  factory FunderSplit.fromJson(Map<String, dynamic>? j) =>
      FunderSplit(vendor: jInt(j?['vendor']), platform: jInt(j?['platform']));
  final int vendor;
  final int platform;
}

class OfferVendorUsage {
  const OfferVendorUsage({required this.vendor, this.redemptions = 0, this.discountGiven = 0});
  factory OfferVendorUsage.fromJson(Map<String, dynamic> j) => OfferVendorUsage(
        vendor: refOf(j['vendor']),
        redemptions: jInt(j['redemptions']),
        discountGiven: jInt(j['discountGiven']),
      );
  final PersonRef vendor;
  final int redemptions;
  final int discountGiven;
}

class OfferDay {
  const OfferDay({required this.date, this.redemptions = 0, this.discountGiven = 0});
  factory OfferDay.fromJson(Map<String, dynamic> j) =>
      OfferDay(date: jStrOr(j['date']), redemptions: jInt(j['redemptions']), discountGiven: jInt(j['discountGiven']));
  final String date;
  final int redemptions;
  final int discountGiven;
}

class OfferUsage {
  const OfferUsage({
    this.from,
    this.to,
    this.redemptions = 0,
    this.uniqueCustomers = 0,
    this.newCustomers = 0,
    this.orders = 0,
    this.cancelledRedemptions = 0,
    this.discountGiven = 0,
    this.discountByFunder = const FunderSplit(),
    this.customerPaid = 0,
    this.remainingRedemptions,
    this.byVendor = const [],
    this.daily = const [],
  });

  factory OfferUsage.fromJson(Map<String, dynamic>? j) => OfferUsage(
        from: jStr(j?['from']),
        to: jStr(j?['to']),
        redemptions: jInt(j?['redemptions']),
        uniqueCustomers: jInt(j?['uniqueCustomers']),
        newCustomers: jInt(j?['newCustomers']),
        orders: jInt(j?['orders']),
        cancelledRedemptions: jInt(j?['cancelledRedemptions']),
        discountGiven: jInt(j?['discountGiven']),
        discountByFunder: FunderSplit.fromJson(jMap(j?['discountByFunder'])),
        customerPaid: jInt(j?['customerPaid']),
        remainingRedemptions: jIntOrNull(j?['remainingRedemptions']),
        byVendor: [for (final m in jMaps(j?['byVendor'])) OfferVendorUsage.fromJson(m)],
        daily: [for (final m in jMaps(j?['daily'])) OfferDay.fromJson(m)],
      );

  final String? from;
  final String? to;
  final int redemptions;
  final int uniqueCustomers;
  final int newCustomers;
  final int orders;
  final int cancelledRedemptions;
  final int discountGiven;
  final FunderSplit discountByFunder;
  final int customerPaid;
  final int? remainingRedemptions;
  final List<OfferVendorUsage> byVendor;
  final List<OfferDay> daily;
}

class FieldChange {
  const FieldChange({required this.field, this.before, this.after});
  factory FieldChange.fromJson(Map<String, dynamic> j) =>
      FieldChange(field: jStrOr(j['field']), before: _text(j['before']), after: _text(j['after']));
  final String field;
  final String? before;
  final String? after;
}

String? _text(Object? v) => v == null ? null : (v is String ? v : '$v');

class ChangeActor {
  const ChangeActor({required this.id, required this.name, required this.role});
  static ChangeActor? fromJson(Object? v) {
    final m = jMap(v);
    if (m == null) return null;
    return ChangeActor(id: jStrOr(m['id']), name: jStrOr(m['name']), role: jStrOr(m['role']));
  }

  final String id;
  final String name;
  final String role;
}

/// One recorded change to an offer's rules (§9.10).
class OfferChange {
  const OfferChange({required this.id, required this.op, required this.target, this.at, this.actor, this.fields = const [], this.reason});
  factory OfferChange.fromJson(Map<String, dynamic> j) => OfferChange(
        // A bigint sent as a string; read a number too, without losing digits we have.
        id: _text(j['id']) ?? '',
        at: jDate(j['at']),
        actor: ChangeActor.fromJson(j['actor']),
        op: jStrOr(j['op']),
        target: jStrOr(j['target']),
        fields: [for (final m in jMaps(j['fields'])) FieldChange.fromJson(m)],
        reason: jStr(j['reason']),
      );

  final String id;
  final DateTime? at;
  final ChangeActor? actor;
  final String op;
  final String target;
  final List<FieldChange> fields;
  final String? reason;
}

class OfferCounts {
  const OfferCounts({this.scheduled = 0, this.active = 0, this.expired = 0, this.inactive = 0, this.exhausted = 0});
  factory OfferCounts.fromJson(Map<String, dynamic>? j) => OfferCounts(
        scheduled: jInt(j?['scheduled']),
        active: jInt(j?['active']),
        expired: jInt(j?['expired']),
        inactive: jInt(j?['inactive']),
        exhausted: jInt(j?['exhausted']),
      );
  final int scheduled;
  final int active;
  final int expired;
  final int inactive;
  final int exhausted;

  int of(OfferState s) => switch (s) {
        OfferState.scheduled => scheduled,
        OfferState.active => active,
        OfferState.expired => expired,
        OfferState.inactive => inactive,
        OfferState.exhausted => exhausted,
        OfferState.unknown => 0,
      };
}

class OfferPage {
  const OfferPage({required this.items, this.nextCursor, this.counts = const OfferCounts()});
  factory OfferPage.fromJson(Map<String, dynamic> j) => OfferPage(
        items: [for (final m in jMaps(j['items'])) OfferSummary.fromJson(m)],
        nextCursor: jStr(j['nextCursor']),
        counts: OfferCounts.fromJson(jMap(j['counts'])),
      );
  final List<OfferSummary> items;
  final String? nextCursor;
  final OfferCounts counts;
}

class OfferBundle {
  const OfferBundle({required this.offer, this.usage = const OfferUsage(), this.changes = const []});
  factory OfferBundle.fromJson(Map<String, dynamic> j) => OfferBundle(
        offer: OfferDetail.fromJson(jMap(j['offer']) ?? const {}),
        usage: OfferUsage.fromJson(jMap(j['usage'])),
        changes: [for (final m in jMaps(j['changes'])) OfferChange.fromJson(m)],
      );
  final OfferDetail offer;
  final OfferUsage usage;
  final List<OfferChange> changes;
}

/// The list's filters.
class OfferFilters {
  const OfferFilters({this.state, this.vendorId, this.zoneId, this.q});
  final OfferState? state;
  final String? vendorId;
  final String? zoneId;
  final String? q;

  Map<String, String> toQuery() => {
        'state': state?.name ?? 'all',
        'vendor': ?vendorId,
        'zone': ?zoneId,
        if (q != null && q!.isNotEmpty) 'q': q!,
      };

  OfferFilters copyWith({Object? state = _u, Object? vendorId = _u, Object? zoneId = _u, Object? q = _u}) => OfferFilters(
        state: identical(state, _u) ? this.state : state as OfferState?,
        vendorId: identical(vendorId, _u) ? this.vendorId : vendorId as String?,
        zoneId: identical(zoneId, _u) ? this.zoneId : zoneId as String?,
        q: identical(q, _u) ? this.q : q as String?,
      );

  bool get narrowed => vendorId != null || (q?.isNotEmpty ?? false);

  @override
  bool operator ==(Object other) => other is OfferFilters && other.state == state && other.vendorId == vendorId && other.zoneId == zoneId && other.q == q;
  @override
  int get hashCode => Object.hash(state, vendorId, zoneId, q);
}

const _u = Object();

/// An edit to an existing offer: only what changed, the version it was made
/// against, and why. The id is minted once so a retry is the same edit.
class OfferEdit {
  OfferEdit({required this.changes, required this.expectedUpdatedAt, required this.reason, String? clientActionId})
      : clientActionId = clientActionId ?? _uuid.v4();
  final Map<String, dynamic> changes;
  final DateTime? expectedUpdatedAt;
  final String reason;
  final String clientActionId;

  Map<String, dynamic> toJson() => {
        'expectedUpdatedAt': expectedUpdatedAt?.toUtc().toIso8601String(),
        'changes': changes,
        'reason': reason,
        'clientActionId': clientActionId,
      };
}

/// The fields of [next] that differ from [before], in wire form (never `code`).
Map<String, dynamic> offerChanges(OfferTerms before, OfferTerms next) {
  final a = before.toJson(), b = next.toJson();
  bool same(Object? x, Object? y) => x is List && y is List ? (x.toSet().length == y.toSet().length && x.toSet().containsAll(y)) : x == y;
  return {
    for (final k in b.keys)
      if (k != 'code' && k != 'requestId' && !same(a[k], b[k])) k: b[k],
  };
}

class OfferAction {
  OfferAction({required this.activate, required this.reason, String? clientActionId}) : clientActionId = clientActionId ?? _uuid.v4();
  final bool activate;
  final String reason;
  final String clientActionId;
  Map<String, dynamic> toJson() =>
      {'action': activate ? 'activate' : 'deactivate', 'reason': reason, 'clientActionId': clientActionId};
}

/// A fresh id for a new write; the screen keeps it until the write lands.
String newActionId() => _uuid.v4();
