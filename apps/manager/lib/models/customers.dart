import 'package:uuid/uuid.dart';

import 'json_util.dart';
import 'offers.dart' show refOf, refsOf;
import 'vendors.dart' show PersonRef;

/// Customers (§10) — `/api/manager/customers*`. Payloads carry a masked phone
/// only; the full contact comes from one audited reveal (§10.2, §10.9).

const _uuid = Uuid();

enum CustomerStatus {
  active('Active'),
  restricted('Restricted'),
  suspended('Suspended'),
  unknown('Unknown');

  const CustomerStatus(this.label);
  final String label;
  static CustomerStatus parse(Object? v) => jEnum(values, v, unknown);
  static const tabs = [active, restricted, suspended];

  /// What the status means for the customer, in plain words.
  String get explanation => switch (this) {
        active => 'Can sign in and order.',
        restricted => 'Can sign in, cannot place orders.',
        suspended => 'Cannot sign in or order.',
        unknown => '',
      };
}

class CustomerSummary {
  const CustomerSummary({
    required this.id,
    required this.shortId,
    required this.status,
    this.name,
    this.phoneMasked,
    this.memberSince,
    this.orders = 0,
    this.spent = 0,
    this.lastOrderAt,
    this.zones = const [],
  });

  factory CustomerSummary.fromJson(Map<String, dynamic> j) => CustomerSummary(
        id: jStrOr(j['id']),
        shortId: jStrOr(j['shortId']),
        name: jStr(j['name']),
        phoneMasked: jStr(j['phoneMasked']),
        status: CustomerStatus.parse(j['status']),
        memberSince: jDate(j['memberSince']),
        orders: jInt(j['orders']),
        spent: jInt(j['spent']),
        lastOrderAt: jDate(j['lastOrderAt']),
        zones: refsOf(j['zones']),
      );

  final String id;
  final String shortId;
  final String? name;
  final String? phoneMasked;
  final CustomerStatus status;
  final DateTime? memberSince;
  final int orders;
  final int spent;
  final DateTime? lastOrderAt;
  final List<PersonRef> zones;

  String get displayName => (name?.trim().isNotEmpty ?? false) ? name!.trim() : 'Customer $shortId';
}

class CustomerAllowed {
  const CustomerAllowed({
    this.revealContact = false,
    this.suspend = false,
    this.restrict = false,
    this.reactivate = false,
    this.decideRefunds = false,
  });
  factory CustomerAllowed.fromJson(Map<String, dynamic>? j) => CustomerAllowed(
        revealContact: jBool(j?['revealContact']),
        suspend: jBool(j?['suspend']),
        restrict: jBool(j?['restrict']),
        reactivate: jBool(j?['reactivate']),
        decideRefunds: jBool(j?['decideRefunds']),
      );
  final bool revealContact;
  final bool suspend;
  final bool restrict;
  final bool reactivate;
  final bool decideRefunds;
}

class CustomerDetail extends CustomerSummary {
  const CustomerDetail({
    required super.id,
    required super.shortId,
    required super.status,
    super.name,
    super.phoneMasked,
    super.memberSince,
    super.orders,
    super.spent,
    super.lastOrderAt,
    super.zones,
    this.statusReason,
    this.statusChangedAt,
    this.statusChangedBy,
    this.localities = const [],
    this.cancelledOrders = 0,
    this.aov = 0,
    this.firstOrderAt,
    this.ratingsGiven = 0,
    this.avgRatingGiven,
    this.openComplaints = 0,
    this.pendingRefunds = 0,
    this.allowed = const CustomerAllowed(),
  });

  factory CustomerDetail.fromJson(Map<String, dynamic> j) {
    final s = CustomerSummary.fromJson(j);
    return CustomerDetail(
      id: s.id,
      shortId: s.shortId,
      name: s.name,
      phoneMasked: s.phoneMasked,
      status: s.status,
      memberSince: s.memberSince,
      orders: s.orders,
      spent: s.spent,
      lastOrderAt: s.lastOrderAt,
      zones: s.zones,
      statusReason: jStr(j['statusReason']),
      statusChangedAt: jDate(j['statusChangedAt']),
      statusChangedBy: PersonRef.fromJson(j['statusChangedBy']),
      localities: jStrings(j['localities']),
      cancelledOrders: jInt(j['cancelledOrders']),
      aov: jInt(j['aov']),
      firstOrderAt: jDate(j['firstOrderAt']),
      ratingsGiven: jInt(j['ratingsGiven']),
      avgRatingGiven: jDoubleOrNull(j['avgRatingGiven']),
      openComplaints: jInt(j['openComplaints']),
      pendingRefunds: jInt(j['pendingRefunds']),
      allowed: CustomerAllowed.fromJson(jMap(j['allowed'])),
    );
  }

  final String? statusReason;
  final DateTime? statusChangedAt;
  final PersonRef? statusChangedBy;
  final List<String> localities;
  final int cancelledOrders;
  final int aov;
  final DateTime? firstOrderAt;
  final int ratingsGiven;
  final double? avgRatingGiven;
  final int openComplaints;
  final int pendingRefunds;
  final CustomerAllowed allowed;
}

class CustomerPage {
  const CustomerPage({required this.items, this.nextCursor});
  factory CustomerPage.fromJson(Map<String, dynamic> j) => CustomerPage(
        items: [for (final m in jMaps(j['items'])) CustomerSummary.fromJson(m)],
        nextCursor: jStr(j['nextCursor']),
      );
  final List<CustomerSummary> items;
  final String? nextCursor;
}

enum CustomerSort {
  recent('Recent'),
  orders('Most orders'),
  spend('Highest spend');

  const CustomerSort(this.label);
  final String label;
}

class CustomerFilters {
  const CustomerFilters({this.q, this.phone, this.status, this.zoneId, this.sort = CustomerSort.recent});
  final String? q;

  /// 10 digits; only sent with `manager.customers.contact` (each search is audited).
  final String? phone;
  final CustomerStatus? status;
  final String? zoneId;
  final CustomerSort sort;

  Map<String, String> toQuery() => {
        if (q != null && q!.isNotEmpty) 'q': q!,
        if (phone != null && phone!.isNotEmpty) 'phone': phone!,
        'status': ?status?.name,
        'zone': ?zoneId,
        'sort': sort.name,
      };

  CustomerFilters copyWith({Object? q = _u, Object? phone = _u, Object? status = _u, Object? zoneId = _u, CustomerSort? sort}) =>
      CustomerFilters(
        q: identical(q, _u) ? this.q : q as String?,
        phone: identical(phone, _u) ? this.phone : phone as String?,
        status: identical(status, _u) ? this.status : status as CustomerStatus?,
        zoneId: identical(zoneId, _u) ? this.zoneId : zoneId as String?,
        sort: sort ?? this.sort,
      );

  bool get narrowed => (q?.isNotEmpty ?? false) || (phone?.isNotEmpty ?? false) || status != null;

  @override
  bool operator ==(Object other) =>
      other is CustomerFilters && other.q == q && other.phone == phone && other.status == status && other.zoneId == zoneId && other.sort == sort;
  @override
  int get hashCode => Object.hash(q, phone, status, zoneId, sort);
}

const _u = Object();

class CustomerReview {
  const CustomerReview({
    required this.id,
    required this.vendor,
    required this.rating,
    this.orderCode,
    this.comment,
    this.createdAt,
    this.flagged = false,
    this.reply,
  });
  factory CustomerReview.fromJson(Map<String, dynamic> j) => CustomerReview(
        id: jStrOr(j['id']),
        vendor: refOf(j['vendor']),
        orderCode: jStr(j['orderCode']),
        rating: jInt(j['rating']),
        comment: jStr(j['comment']),
        createdAt: jDate(j['createdAt']),
        flagged: jBool(j['flagged']),
        reply: jStr(j['reply']),
      );
  final String id;
  final PersonRef vendor;
  final String? orderCode;
  final int rating;
  final String? comment;
  final DateTime? createdAt;
  final bool flagged;
  final String? reply;
}

class CustomerRiderRating {
  const CustomerRiderRating({required this.id, required this.riderName, required this.rating, this.riderCode, this.orderCode, this.comment, this.createdAt});
  factory CustomerRiderRating.fromJson(Map<String, dynamic> j) {
    final r = jMap(j['rider']);
    return CustomerRiderRating(
      id: jStrOr(j['id']),
      riderName: jStrOr(r?['name']),
      riderCode: jStr(r?['code']),
      orderCode: jStr(j['orderCode']),
      rating: jInt(j['rating']),
      comment: jStr(j['comment']),
      createdAt: jDate(j['createdAt']),
    );
  }
  final String id;
  final String riderName;
  final String? riderCode;
  final String? orderCode;
  final int rating;
  final String? comment;
  final DateTime? createdAt;
}

class CustomerFeedback {
  const CustomerFeedback({this.reviews = const [], this.riderRatings = const [], this.nextCursor});
  factory CustomerFeedback.fromJson(Map<String, dynamic> j) => CustomerFeedback(
        reviews: [for (final m in jMaps(j['reviews'])) CustomerReview.fromJson(m)],
        riderRatings: [for (final m in jMaps(j['riderRatings'])) CustomerRiderRating.fromJson(m)],
        nextCursor: jStr(j['nextCursor']),
      );
  final List<CustomerReview> reviews;
  final List<CustomerRiderRating> riderRatings;
  final String? nextCursor;
}

class RetentionSummary {
  const RetentionSummary({
    this.customers = 0,
    this.newCustomers = 0,
    this.returningCustomers = 0,
    this.repeatRate,
    this.ordersPerCustomer,
    this.aovPerCustomer = 0,
  });
  factory RetentionSummary.fromJson(Map<String, dynamic>? j) => RetentionSummary(
        customers: jInt(j?['customers']),
        newCustomers: jInt(j?['newCustomers']),
        returningCustomers: jInt(j?['returningCustomers']),
        repeatRate: jDoubleOrNull(j?['repeatRate']),
        ordersPerCustomer: jDoubleOrNull(j?['ordersPerCustomer']),
        aovPerCustomer: jInt(j?['aovPerCustomer']),
      );
  final int customers;
  final int newCustomers;
  final int returningCustomers;
  final double? repeatRate;
  final double? ordersPerCustomer;
  final int aovPerCustomer;
}

class RetentionCohort {
  const RetentionCohort({required this.cohort, this.customers = 0, this.r30, this.r60, this.r90});
  factory RetentionCohort.fromJson(Map<String, dynamic> j) => RetentionCohort(
        cohort: jStrOr(j['cohort']),
        customers: jInt(j['customers']),
        r30: jDoubleOrNull(j['r30']),
        r60: jDoubleOrNull(j['r60']),
        r90: jDoubleOrNull(j['r90']),
      );

  /// `YYYY-MM`, the IST month of the cohort's first order.
  final String cohort;
  final int customers;

  /// Percent who ordered again within N days; null until the cohort is that old.
  final double? r30;
  final double? r60;
  final double? r90;
}

class Retention {
  const Retention({this.from, this.to, this.summary = const RetentionSummary(), this.cohorts = const []});
  factory Retention.fromJson(Map<String, dynamic> j) => Retention(
        from: jStr(j['from']),
        to: jStr(j['to']),
        summary: RetentionSummary.fromJson(jMap(j['summary'])),
        cohorts: [for (final m in jMaps(j['cohorts'])) RetentionCohort.fromJson(m)],
      );
  final String? from;
  final String? to;
  final RetentionSummary summary;
  final List<RetentionCohort> cohorts;
}

/// A percentage to one decimal, or "—" when there isn't one yet.
String pctOrDash(double? v) => v == null ? '—' : '${v.toStringAsFixed(1)}%';

enum ContactReason {
  orderIssue('order_issue', 'Problem with an order'),
  refund('refund', 'Refund'),
  complaint('complaint', 'Complaint'),
  delivery('delivery', 'Delivery'),
  other('other', 'Other');

  const ContactReason(this.wire, this.label);
  final String wire;
  final String label;
}

class ContactReveal {
  const ContactReveal({this.phone, this.email});
  factory ContactReveal.fromJson(Map<String, dynamic> j) => ContactReveal(phone: jStr(j['phone']), email: jStr(j['email']));
  final String? phone;
  final String? email;
}

enum CustomerActionKind {
  suspend('suspend', 'Suspend'),
  restrict('restrict', 'Restrict'),
  reactivate('reactivate', 'Reactivate');

  const CustomerActionKind(this.wire, this.label);
  final String wire;
  final String label;

  String get explanation => switch (this) {
        suspend => 'The customer cannot sign in or order until reactivated. Their open sessions end.',
        restrict => 'The customer can still sign in, but cannot place orders until reactivated.',
        reactivate => 'The customer can sign in and order again.',
      };
}

class CustomerAction {
  CustomerAction({required this.kind, required this.expected, required this.reason, String? clientActionId})
      : clientActionId = clientActionId ?? _uuid.v4();
  final CustomerActionKind kind;
  final CustomerStatus expected;
  final String reason;
  final String clientActionId;
  Map<String, dynamic> toJson() =>
      {'action': kind.wire, 'expected': expected.name, 'reason': reason, 'clientActionId': clientActionId};
}
