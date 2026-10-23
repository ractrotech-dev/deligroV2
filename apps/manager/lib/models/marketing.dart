import 'package:uuid/uuid.dart';

import 'json_util.dart';
import 'offers.dart';
import 'vendors.dart' show PersonRef;

/// Marketing requests and campaigns (§8) — `/api/manager/marketing/*`.

const _uuid = Uuid();

enum MarketingType {
  featuredStore('featured_store', 'Featured store'),
  banner('banner', 'Banner'),
  seasonal('seasonal', 'Seasonal / festival'),
  sponsoredProduct('sponsored_product', 'Sponsored products'),
  discountOffer('discount_offer', 'Discount offer'),
  other('other', 'Other'),
  unknown('unknown', 'Other request');

  const MarketingType(this.wire, this.label);
  final String wire;
  final String label;
  static MarketingType parse(Object? v) => jEnum(values, v, unknown, (t) => t.wire);

  /// What approving this request creates.
  CampaignKind? get campaignKind => switch (this) {
        featuredStore => CampaignKind.featuredStore,
        banner => CampaignKind.banner,
        seasonal => CampaignKind.seasonal,
        sponsoredProduct => CampaignKind.sponsoredProduct,
        _ => null,
      };

  static const pickable = [featuredStore, banner, seasonal, sponsoredProduct, discountOffer, other];
}

/// The spec's five statuses (§8).
enum RequestStatus {
  pending('pending', 'Pending'),
  approved('approved', 'Approved'),
  rejected('rejected', 'Rejected'),
  inProgress('in_progress', 'In progress'),
  completed('completed', 'Completed'),
  unknown('unknown', 'Unknown');

  const RequestStatus(this.wire, this.label);
  final String wire;
  final String label;
  static RequestStatus parse(Object? v) => jEnum(values, v, unknown, (s) => s.wire);

  static const tabs = [pending, approved, rejected, inProgress, completed];
}

class RequestCounts {
  const RequestCounts({this.pending = 0, this.approved = 0, this.rejected = 0, this.inProgress = 0, this.completed = 0});
  factory RequestCounts.fromJson(Map<String, dynamic>? j) => RequestCounts(
        pending: jInt(j?['pending']),
        approved: jInt(j?['approved']),
        rejected: jInt(j?['rejected']),
        inProgress: jInt(j?['in_progress']),
        completed: jInt(j?['completed']),
      );
  final int pending;
  final int approved;
  final int rejected;
  final int inProgress;
  final int completed;

  int of(RequestStatus s) => switch (s) {
        RequestStatus.pending => pending,
        RequestStatus.approved => approved,
        RequestStatus.rejected => rejected,
        RequestStatus.inProgress => inProgress,
        RequestStatus.completed => completed,
        RequestStatus.unknown => 0,
      };
}

class Requester {
  const Requester({required this.id, required this.name, required this.role});
  factory Requester.fromJson(Map<String, dynamic>? j) =>
      Requester(id: jStrOr(j?['id']), name: jStrOr(j?['name']), role: jStrOr(j?['role']));
  final String id;
  final String name;

  /// `restaurant` (the vendor asked) | `manager` | `admin` (recorded for them).
  final String role;
  bool get isVendor => role == 'restaurant';
}

class MarketingRequest {
  const MarketingRequest({
    required this.id,
    required this.number,
    required this.vendor,
    required this.zone,
    required this.type,
    required this.title,
    required this.status,
    required this.requestedBy,
    this.source = 'vendor',
    this.details = '',
    this.preferredStart,
    this.preferredEnd,
    this.budget,
    this.items = const [],
    this.proposedOffer,
    this.attachmentUrl,
    this.remarks,
    this.decidedBy,
    this.decidedAt,
    this.campaignId,
    this.offerCode,
    this.createdAt,
    this.updatedAt,
  });

  factory MarketingRequest.fromJson(Map<String, dynamic> j) {
    final offer = jMap(j['proposedOffer']);
    return MarketingRequest(
      id: jStrOr(j['id']),
      number: jInt(j['number']),
      vendor: refOf(j['vendor']),
      zone: refOf(j['zone']),
      source: jStrOr(j['source'], 'vendor'),
      type: MarketingType.parse(j['type']),
      title: jStrOr(j['title']),
      details: jStrOr(j['details']),
      preferredStart: jStr(j['preferredStart']),
      preferredEnd: jStr(j['preferredEnd']),
      budget: jIntOrNull(j['budget']),
      items: refsOf(j['items']),
      proposedOffer: offer == null ? null : OfferTerms.fromJson(offer),
      attachmentUrl: jStr(j['attachmentUrl']),
      status: RequestStatus.parse(j['status']),
      remarks: jStr(j['remarks']),
      requestedBy: Requester.fromJson(jMap(j['requestedBy'])),
      decidedBy: PersonRef.fromJson(j['decidedBy']),
      decidedAt: jDate(j['decidedAt']),
      campaignId: jStr(j['campaignId']),
      offerCode: jStr(j['offerCode']),
      createdAt: jDate(j['createdAt']),
      updatedAt: jDate(j['updatedAt']),
    );
  }

  final String id;
  final int number;
  final PersonRef vendor;
  final PersonRef zone;
  final String source;
  final MarketingType type;
  final String title;
  final String details;

  /// IST dates, `YYYY-MM-DD`.
  final String? preferredStart;
  final String? preferredEnd;
  final int? budget;
  final List<PersonRef> items;
  final OfferTerms? proposedOffer;
  final String? attachmentUrl;
  final RequestStatus status;
  final String? remarks;
  final Requester requestedBy;
  final PersonRef? decidedBy;
  final DateTime? decidedAt;
  final String? campaignId;
  final String? offerCode;
  final DateTime? createdAt;
  final DateTime? updatedAt;
}

class MarketingRequestPage {
  const MarketingRequestPage({required this.items, this.nextCursor, this.counts = const RequestCounts()});
  factory MarketingRequestPage.fromJson(Map<String, dynamic> j) => MarketingRequestPage(
        items: [for (final m in jMaps(j['items'])) MarketingRequest.fromJson(m)],
        nextCursor: jStr(j['nextCursor']),
        counts: RequestCounts.fromJson(jMap(j['counts'])),
      );
  final List<MarketingRequest> items;
  final String? nextCursor;
  final RequestCounts counts;
}

class RequestBundle {
  const RequestBundle({required this.request, this.campaign, this.offer});
  factory RequestBundle.fromJson(Map<String, dynamic> j) {
    final c = jMap(j['campaign']), o = jMap(j['offer']);
    return RequestBundle(
      request: MarketingRequest.fromJson(jMap(j['request']) ?? const {}),
      campaign: c == null ? null : CampaignSummary.fromJson(c),
      offer: o == null ? null : OfferSummary.fromJson(o),
    );
  }
  final MarketingRequest request;
  final CampaignSummary? campaign;
  final OfferSummary? offer;
}

class RequestFilters {
  const RequestFilters({this.status, this.type, this.vendorId, this.zoneId});
  final RequestStatus? status;
  final MarketingType? type;
  final String? vendorId;
  final String? zoneId;

  factory RequestFilters.fromUri(Uri uri) {
    final p = uri.queryParameters;
    final s = p['status'];
    return RequestFilters(
      status: s == null ? RequestStatus.pending : (RequestStatus.parse(s) == RequestStatus.unknown ? null : RequestStatus.parse(s)),
      vendorId: p['vendor'],
    );
  }

  Map<String, String> toQuery() => {
        'status': ?status?.wire,
        'type': ?type?.wire,
        'vendor': ?vendorId,
        'zone': ?zoneId,
      };

  RequestFilters copyWith({Object? status = _u, Object? type = _u, Object? vendorId = _u, Object? zoneId = _u}) => RequestFilters(
        status: identical(status, _u) ? this.status : status as RequestStatus?,
        type: identical(type, _u) ? this.type : type as MarketingType?,
        vendorId: identical(vendorId, _u) ? this.vendorId : vendorId as String?,
        zoneId: identical(zoneId, _u) ? this.zoneId : zoneId as String?,
      );

  bool get narrowed => type != null || vendorId != null;

  @override
  bool operator ==(Object other) =>
      other is RequestFilters && other.status == status && other.type == type && other.vendorId == vendorId && other.zoneId == zoneId;
  @override
  int get hashCode => Object.hash(status, type, vendorId, zoneId);
}

const _u = Object();

// ── Campaigns ──────────────────────────────────────────────────────────────

enum CampaignKind {
  featuredStore('featured_store', 'Featured store'),
  banner('banner', 'Banner'),
  seasonal('seasonal', 'Seasonal / festival'),
  sponsoredProduct('sponsored_product', 'Sponsored products'),
  unknown('unknown', 'Campaign');

  const CampaignKind(this.wire, this.label);
  final String wire;
  final String label;
  static CampaignKind parse(Object? v) => jEnum(values, v, unknown, (k) => k.wire);
  static const pickable = [featuredStore, banner, seasonal, sponsoredProduct];

  bool get hasBanner => this == banner || this == seasonal;
}

enum CampaignStatus {
  approved('approved', 'Approved'),
  inProgress('in_progress', 'In progress'),
  completed('completed', 'Completed'),
  cancelled('cancelled', 'Cancelled'),
  unknown('unknown', 'Unknown');

  const CampaignStatus(this.wire, this.label);
  final String wire;
  final String label;
  static CampaignStatus parse(Object? v) => jEnum(values, v, unknown, (s) => s.wire);
}

/// Computed from the window by the server (§8.12).
enum CampaignState {
  active('Active'),
  scheduled('Scheduled'),
  expired('Expired'),
  unknown('Unknown');

  const CampaignState(this.label);
  final String label;
  static CampaignState parse(Object? v) => jEnum(values, v, unknown);
  static const tabs = [active, scheduled, expired];
}

/// Who pays for a campaign (recorded, not billed — §8.9).
enum Funding {
  vendor('vendor', 'Vendor'),
  deligro('deligro', 'Deligro'),
  shared('shared', 'Shared'),
  unknown('unknown', '—');

  const Funding(this.wire, this.label);
  final String wire;
  final String label;
  static Funding parse(Object? v) => jEnum(values, v, unknown, (f) => f.wire);
  static const pickable = [deligro, vendor, shared];
}

class BannerFields {
  const BannerFields({
    this.headline = '',
    this.description = '',
    this.ctaLabel = 'Order now',
    this.targetType = 'restaurant',
    this.targetValue,
    this.imageUrl,
    this.placements = const ['home_top'],
  });

  factory BannerFields.fromJson(Map<String, dynamic> j) => BannerFields(
        headline: jStrOr(j['headline']),
        description: jStrOr(j['description']),
        ctaLabel: jStrOr(j['ctaLabel']),
        targetType: jStrOr(j['targetType'], 'restaurant'),
        targetValue: jStr(j['targetValue']),
        imageUrl: jStr(j['imageUrl']),
        placements: jStrings(j['placements']),
      );

  final String headline;
  final String description;
  final String ctaLabel;

  /// `restaurant|product|category|food|external`.
  final String targetType;
  final String? targetValue;
  final String? imageUrl;
  final List<String> placements;

  Map<String, dynamic> toJson() => {
        'headline': headline,
        'description': description,
        'ctaLabel': ctaLabel,
        'targetType': targetType,
        'targetValue': targetValue,
        'imageUrl': imageUrl,
        'placements': placements,
      };

  BannerFields copyWith({String? headline, String? description, String? ctaLabel, String? targetType, Object? targetValue = _u, Object? imageUrl = _u}) =>
      BannerFields(
        headline: headline ?? this.headline,
        description: description ?? this.description,
        ctaLabel: ctaLabel ?? this.ctaLabel,
        targetType: targetType ?? this.targetType,
        targetValue: identical(targetValue, _u) ? this.targetValue : targetValue as String?,
        imageUrl: identical(imageUrl, _u) ? this.imageUrl : imageUrl as String?,
        placements: placements,
      );
}

class CampaignHeadline {
  const CampaignHeadline({this.impressions = 0, this.clicks = 0, this.attributedOrders = 0, this.attributedSales = 0});
  factory CampaignHeadline.fromJson(Map<String, dynamic>? j) => CampaignHeadline(
        impressions: jInt(j?['impressions']),
        clicks: jInt(j?['clicks']),
        attributedOrders: jInt(j?['attributedOrders']),
        attributedSales: jInt(j?['attributedSales']),
      );
  final int impressions;
  final int clicks;
  final int attributedOrders;
  final int attributedSales;
}

class CampaignSummary {
  const CampaignSummary({
    required this.id,
    required this.kind,
    required this.title,
    required this.zone,
    required this.status,
    required this.state,
    required this.fundedBy,
    this.vendors = const [],
    this.startsAt,
    this.endsAt,
    this.budget,
    this.vendorSharePct,
    this.slotPosition,
    this.offerCode,
    this.requestId,
    this.headline = const CampaignHeadline(),
  });

  factory CampaignSummary.fromJson(Map<String, dynamic> j) => CampaignSummary(
        id: jStrOr(j['id']),
        kind: CampaignKind.parse(j['kind']),
        title: jStrOr(j['title']),
        zone: refOf(j['zone']),
        vendors: refsOf(j['vendors']),
        status: CampaignStatus.parse(j['status']),
        state: CampaignState.parse(j['state']),
        startsAt: jDate(j['startsAt']),
        endsAt: jDate(j['endsAt']),
        budget: jIntOrNull(j['budget']),
        fundedBy: Funding.parse(j['fundedBy']),
        vendorSharePct: jIntOrNull(j['vendorSharePct']),
        slotPosition: jIntOrNull(j['slotPosition']),
        offerCode: jStr(j['offerCode']),
        requestId: jStr(j['requestId']),
        headline: CampaignHeadline.fromJson(jMap(j['headline'])),
      );

  final String id;
  final CampaignKind kind;
  final String title;
  final PersonRef zone;
  final List<PersonRef> vendors;
  final CampaignStatus status;
  final CampaignState state;
  final DateTime? startsAt;
  final DateTime? endsAt;
  final int? budget;
  final Funding fundedBy;
  final int? vendorSharePct;
  final int? slotPosition;
  final String? offerCode;
  final String? requestId;
  final CampaignHeadline headline;

  /// "Deligro", "Vendor", "Shared (vendor 40%)".
  String get fundingLabel =>
      fundedBy == Funding.shared && vendorSharePct != null ? 'Shared (vendor $vendorSharePct%)' : fundedBy.label;
}

class CampaignAllowed {
  const CampaignAllowed({this.edit = false, this.editWindowOnly = false, this.cancel = false, this.endNow = false, this.uploadImage = false});
  factory CampaignAllowed.fromJson(Map<String, dynamic>? j) => CampaignAllowed(
        edit: jBool(j?['edit']),
        editWindowOnly: jBool(j?['editWindowOnly']),
        cancel: jBool(j?['cancel']),
        endNow: jBool(j?['endNow']),
        uploadImage: jBool(j?['uploadImage']),
      );
  final bool edit;

  /// Started: only the end date, budget, notes and banner may change.
  final bool editWindowOnly;
  final bool cancel;
  final bool endNow;
  final bool uploadImage;
}

class CampaignDetail extends CampaignSummary {
  const CampaignDetail({
    required super.id,
    required super.kind,
    required super.title,
    required super.zone,
    required super.status,
    required super.state,
    required super.fundedBy,
    super.vendors,
    super.startsAt,
    super.endsAt,
    super.budget,
    super.vendorSharePct,
    super.slotPosition,
    super.offerCode,
    super.requestId,
    super.headline,
    this.items = const [],
    this.banner,
    this.notes,
    this.createdBy,
    this.createdAt,
    this.updatedAt,
    this.cancelledReason,
    this.allowed = const CampaignAllowed(),
  });

  factory CampaignDetail.fromJson(Map<String, dynamic> j) {
    final s = CampaignSummary.fromJson(j);
    final b = jMap(j['banner']);
    return CampaignDetail(
      id: s.id,
      kind: s.kind,
      title: s.title,
      zone: s.zone,
      vendors: s.vendors,
      status: s.status,
      state: s.state,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      budget: s.budget,
      fundedBy: s.fundedBy,
      vendorSharePct: s.vendorSharePct,
      slotPosition: s.slotPosition,
      offerCode: s.offerCode,
      requestId: s.requestId,
      headline: s.headline,
      items: refsOf(j['items']),
      banner: b == null ? null : BannerFields.fromJson(b),
      notes: jStr(j['notes']),
      createdBy: PersonRef.fromJson(j['createdBy']),
      createdAt: jDate(j['createdAt']),
      updatedAt: jDate(j['updatedAt']),
      cancelledReason: jStr(j['cancelledReason']),
      allowed: CampaignAllowed.fromJson(jMap(j['allowed'])),
    );
  }

  final List<PersonRef> items;
  final BannerFields? banner;
  final String? notes;
  final PersonRef? createdBy;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final String? cancelledReason;
  final CampaignAllowed allowed;

  /// This campaign as an editable input.
  CampaignInput get input => CampaignInput(
        kind: kind,
        title: title,
        zoneId: zone.id,
        vendorIds: [for (final v in vendors) v.id],
        itemIds: [for (final i in items) i.id],
        startsAt: startsAt,
        endsAt: endsAt,
        budget: budget,
        fundedBy: fundedBy,
        vendorSharePct: vendorSharePct,
        slotPosition: slotPosition,
        banner: banner,
        offerCode: offerCode,
        requestId: requestId,
        notes: notes,
      );
}

class CampaignComparison {
  const CampaignComparison({this.beforeOrders = 0, this.beforeSales = 0, this.duringOrders = 0, this.duringSales = 0});
  static CampaignComparison? fromJson(Object? v) {
    final j = jMap(v);
    if (j == null) return null;
    return CampaignComparison(
      beforeOrders: jInt(j['beforeOrders']),
      beforeSales: jInt(j['beforeSales']),
      duringOrders: jInt(j['duringOrders']),
      duringSales: jInt(j['duringSales']),
    );
  }

  final int beforeOrders;
  final int beforeSales;
  final int duringOrders;
  final int duringSales;
}

class CampaignDay {
  const CampaignDay({required this.date, this.impressions = 0, this.clicks = 0, this.attributedOrders = 0, this.attributedSales = 0});
  factory CampaignDay.fromJson(Map<String, dynamic> j) => CampaignDay(
        date: jStrOr(j['date']),
        impressions: jInt(j['impressions']),
        clicks: jInt(j['clicks']),
        attributedOrders: jInt(j['attributedOrders']),
        attributedSales: jInt(j['attributedSales']),
      );
  final String date;
  final int impressions;
  final int clicks;
  final int attributedOrders;
  final int attributedSales;
}

class CampaignPerformance {
  const CampaignPerformance({
    this.from,
    this.to,
    this.impressions = 0,
    this.clicks = 0,
    this.ctr,
    this.redemptions = 0,
    this.discountGiven = 0,
    this.attributedOrders = 0,
    this.attributedSales = 0,
    this.attributedCustomers = 0,
    this.comparison,
    this.daily = const [],
  });

  factory CampaignPerformance.fromJson(Map<String, dynamic>? j) => CampaignPerformance(
        from: jStr(j?['from']),
        to: jStr(j?['to']),
        impressions: jInt(j?['impressions']),
        clicks: jInt(j?['clicks']),
        ctr: jDoubleOrNull(j?['ctr']),
        redemptions: jInt(j?['redemptions']),
        discountGiven: jInt(j?['discountGiven']),
        attributedOrders: jInt(j?['attributedOrders']),
        attributedSales: jInt(j?['attributedSales']),
        attributedCustomers: jInt(j?['attributedCustomers']),
        comparison: CampaignComparison.fromJson(j?['comparison']),
        daily: [for (final m in jMaps(j?['daily'])) CampaignDay.fromJson(m)],
      );

  final String? from;
  final String? to;
  final int impressions;
  final int clicks;

  /// Percent, one decimal; null (or meaningless) when there were no impressions.
  final double? ctr;
  final int redemptions;
  final int discountGiven;
  final int attributedOrders;
  final int attributedSales;
  final int attributedCustomers;
  final CampaignComparison? comparison;
  final List<CampaignDay> daily;

  /// "7.0%", or "—" when nothing was shown yet (never NaN).
  String get ctrLabel {
    final v = ctr ?? (impressions == 0 ? null : clicks * 100 / impressions);
    if (v == null || v.isNaN || v.isInfinite || impressions == 0) return '—';
    return '${v.toStringAsFixed(1)}%';
  }
}

class CampaignCounts {
  const CampaignCounts({this.scheduled = 0, this.active = 0, this.expired = 0});
  factory CampaignCounts.fromJson(Map<String, dynamic>? j) =>
      CampaignCounts(scheduled: jInt(j?['scheduled']), active: jInt(j?['active']), expired: jInt(j?['expired']));
  final int scheduled;
  final int active;
  final int expired;
  int of(CampaignState s) => switch (s) {
        CampaignState.scheduled => scheduled,
        CampaignState.active => active,
        CampaignState.expired => expired,
        CampaignState.unknown => 0,
      };
}

class CampaignPage {
  const CampaignPage({required this.items, this.nextCursor, this.counts = const CampaignCounts()});
  factory CampaignPage.fromJson(Map<String, dynamic> j) => CampaignPage(
        items: [for (final m in jMaps(j['items'])) CampaignSummary.fromJson(m)],
        nextCursor: jStr(j['nextCursor']),
        counts: CampaignCounts.fromJson(jMap(j['counts'])),
      );
  final List<CampaignSummary> items;
  final String? nextCursor;
  final CampaignCounts counts;
}

class CampaignBundle {
  const CampaignBundle({required this.campaign, this.performance = const CampaignPerformance()});
  factory CampaignBundle.fromJson(Map<String, dynamic> j) => CampaignBundle(
        campaign: CampaignDetail.fromJson(jMap(j['campaign']) ?? const {}),
        performance: CampaignPerformance.fromJson(jMap(j['performance'])),
      );
  final CampaignDetail campaign;
  final CampaignPerformance performance;
}

class CampaignFilters {
  const CampaignFilters({this.state = CampaignState.active, this.kind, this.vendorId, this.zoneId});
  final CampaignState? state;
  final CampaignKind? kind;
  final String? vendorId;
  final String? zoneId;

  Map<String, String> toQuery() => {
        'state': state?.name ?? 'all',
        'kind': ?kind?.wire,
        'vendor': ?vendorId,
        'zone': ?zoneId,
      };

  CampaignFilters copyWith({Object? state = _u, Object? kind = _u, Object? zoneId = _u}) => CampaignFilters(
        state: identical(state, _u) ? this.state : state as CampaignState?,
        kind: identical(kind, _u) ? this.kind : kind as CampaignKind?,
        vendorId: vendorId,
        zoneId: identical(zoneId, _u) ? this.zoneId : zoneId as String?,
      );

  bool get narrowed => kind != null || vendorId != null;

  @override
  bool operator ==(Object other) => other is CampaignFilters && other.state == state && other.kind == kind && other.vendorId == vendorId && other.zoneId == zoneId;
  @override
  int get hashCode => Object.hash(state, kind, vendorId, zoneId);
}

/// A campaign to create, or the whole of one being edited.
class CampaignInput {
  const CampaignInput({
    required this.kind,
    required this.title,
    required this.zoneId,
    required this.fundedBy,
    this.vendorIds = const [],
    this.itemIds = const [],
    this.startsAt,
    this.endsAt,
    this.budget,
    this.vendorSharePct,
    this.slotPosition,
    this.banner,
    this.offerCode,
    this.requestId,
    this.notes,
  });

  final CampaignKind kind;
  final String title;
  final String zoneId;
  final List<String> vendorIds;
  final List<String> itemIds;
  final DateTime? startsAt;
  final DateTime? endsAt;
  final int? budget;
  final Funding fundedBy;
  final int? vendorSharePct;
  final int? slotPosition;
  final BannerFields? banner;
  final String? offerCode;
  final String? requestId;
  final String? notes;

  /// The contract's `CampaignInput`. Only the fields that belong to the kind
  /// are sent: a slot for a featured store, a share when funding is shared, a
  /// banner for banner and seasonal campaigns, dishes for sponsored products.
  Map<String, dynamic> toJson() => {
        'kind': kind.wire,
        'title': title.trim(),
        'zoneId': zoneId,
        'vendorIds': vendorIds,
        if (kind == CampaignKind.sponsoredProduct) 'itemIds': itemIds,
        'startsAt': startsAt?.toUtc().toIso8601String(),
        'endsAt': endsAt?.toUtc().toIso8601String(),
        'budget': budget,
        'fundedBy': fundedBy.wire,
        if (fundedBy == Funding.shared) 'vendorSharePct': vendorSharePct,
        if (kind == CampaignKind.featuredStore) 'slotPosition': slotPosition,
        if (kind.hasBanner && banner != null) 'banner': banner!.toJson(),
        if (kind == CampaignKind.seasonal && offerCode != null) 'offerCode': offerCode,
        'requestId': requestId,
        'notes': (notes?.trim().isEmpty ?? true) ? null : notes!.trim(),
      };

  /// What's wrong with this input, field → message, before it is sent.
  Map<String, String> problems({DateTime? now}) {
    final out = <String, String>{};
    final t = title.trim();
    if (t.length < 3 || t.length > 80) out['title'] = 'Title must be 3–80 characters';
    if (startsAt == null) out['startsAt'] = 'Pick a start';
    if (endsAt == null) out['endsAt'] = 'Pick an end';
    if (startsAt != null && endsAt != null) {
      if (!endsAt!.isAfter(startsAt!)) out['endsAt'] = 'The end must be after the start';
      if (endsAt!.difference(startsAt!) > const Duration(days: 180)) out['endsAt'] = 'A campaign can run at most 180 days';
    }
    if (fundedBy == Funding.shared && (vendorSharePct == null || vendorSharePct! < 1 || vendorSharePct! > 99)) {
      out['vendorSharePct'] = "Set the vendor's share (1–99%)";
    }
    switch (kind) {
      case CampaignKind.featuredStore:
        if (vendorIds.length != 1) out['vendorIds'] = 'Pick the shop to feature';
        if (slotPosition == null) out['slotPosition'] = 'Pick a slot';
      case CampaignKind.sponsoredProduct:
        if (vendorIds.length != 1) out['vendorIds'] = 'Pick the shop';
        if (itemIds.isEmpty || itemIds.length > 20) out['itemIds'] = 'Pick 1–20 dishes';
      case CampaignKind.banner || CampaignKind.seasonal:
        final b = banner;
        if (b == null || b.headline.trim().isEmpty || b.headline.length > 60) out['headline'] = 'Headline must be 1–60 characters';
        if (b != null && (b.ctaLabel.trim().isEmpty || b.ctaLabel.length > 20)) out['ctaLabel'] = 'Button text must be 1–20 characters';
        if (b != null && b.description.length > 140) out['description'] = 'At most 140 characters';
        if (kind == CampaignKind.banner && vendorIds.length > 1) out['vendorIds'] = 'A banner can name one shop at most';
      case CampaignKind.unknown:
        out['kind'] = 'Pick a campaign type';
    }
    if (budget != null && budget! < 0) out['budget'] = "Budget can't be negative";
    return out;
  }

  CampaignInput copyWith({
    CampaignKind? kind,
    String? title,
    String? zoneId,
    List<String>? vendorIds,
    List<String>? itemIds,
    Object? startsAt = _u,
    Object? endsAt = _u,
    Object? budget = _u,
    Funding? fundedBy,
    Object? vendorSharePct = _u,
    Object? slotPosition = _u,
    Object? banner = _u,
    Object? offerCode = _u,
    Object? notes = _u,
  }) =>
      CampaignInput(
        kind: kind ?? this.kind,
        title: title ?? this.title,
        zoneId: zoneId ?? this.zoneId,
        vendorIds: vendorIds ?? this.vendorIds,
        itemIds: itemIds ?? this.itemIds,
        startsAt: identical(startsAt, _u) ? this.startsAt : startsAt as DateTime?,
        endsAt: identical(endsAt, _u) ? this.endsAt : endsAt as DateTime?,
        budget: identical(budget, _u) ? this.budget : budget as int?,
        fundedBy: fundedBy ?? this.fundedBy,
        vendorSharePct: identical(vendorSharePct, _u) ? this.vendorSharePct : vendorSharePct as int?,
        slotPosition: identical(slotPosition, _u) ? this.slotPosition : slotPosition as int?,
        banner: identical(banner, _u) ? this.banner : banner as BannerFields?,
        offerCode: identical(offerCode, _u) ? this.offerCode : offerCode as String?,
        requestId: requestId,
        notes: identical(notes, _u) ? this.notes : notes as String?,
      );
}

/// Approving or rejecting a request. The id is minted once; a retry after a
/// fault sends the same decision with the same id.
class RequestDecision {
  RequestDecision._({required this.approve, required this.expectedStatus, this.remarks, this.campaign, this.offer, String? clientActionId})
      : clientActionId = clientActionId ?? _uuid.v4();

  factory RequestDecision.reject({required String remarks, RequestStatus expectedStatus = RequestStatus.pending}) =>
      RequestDecision._(approve: false, expectedStatus: expectedStatus, remarks: remarks);

  factory RequestDecision.approve({
    String? remarks,
    CampaignInput? campaign,
    OfferTerms? offer,
    RequestStatus expectedStatus = RequestStatus.pending,
  }) =>
      RequestDecision._(approve: true, expectedStatus: expectedStatus, remarks: remarks, campaign: campaign, offer: offer);

  final bool approve;
  final RequestStatus expectedStatus;
  final String? remarks;
  final CampaignInput? campaign;
  final OfferTerms? offer;
  final String clientActionId;

  Map<String, dynamic> toJson() => {
        'decision': approve ? 'approve' : 'reject',
        'expected': expectedStatus.wire,
        'remarks': (remarks?.trim().isEmpty ?? true) ? null : remarks!.trim(),
        if (campaign != null) 'campaign': campaign!.toJson(),
        if (offer != null) 'offer': offer!.toJson(),
        'clientActionId': clientActionId,
      };
}

/// A request recorded for a vendor after a phone call (`source = ops`).
class NewRequestInput {
  NewRequestInput({
    required this.vendorId,
    required this.type,
    required this.title,
    this.details = '',
    this.preferredStart,
    this.preferredEnd,
    this.budget,
    this.itemIds = const [],
    this.proposedOffer,
    String? clientActionId,
  }) : clientActionId = clientActionId ?? _uuid.v4();

  final String vendorId;
  final MarketingType type;
  final String title;
  final String details;
  final String? preferredStart;
  final String? preferredEnd;
  final int? budget;
  final List<String> itemIds;
  final OfferTerms? proposedOffer;
  final String clientActionId;

  Map<String, dynamic> toJson() => {
        'vendorId': vendorId,
        'type': type.wire,
        'title': title.trim(),
        'details': details.trim(),
        'preferredStart': preferredStart,
        'preferredEnd': preferredEnd,
        'budget': budget,
        'itemIds': itemIds,
        'proposedOffer': proposedOffer?.toJson(),
        'clientActionId': clientActionId,
      };
}

/// Moving an `other` request along by hand.
class RequestProgress {
  RequestProgress({required this.status, required this.remarks, String? clientActionId}) : clientActionId = clientActionId ?? _uuid.v4();
  final RequestStatus status;
  final String remarks;
  final String clientActionId;
  Map<String, dynamic> toJson() => {'status': status.wire, 'remarks': remarks, 'clientActionId': clientActionId};
}

class CampaignEdit {
  CampaignEdit({required this.changes, required this.expectedUpdatedAt, this.reason, String? clientActionId})
      : clientActionId = clientActionId ?? _uuid.v4();
  final Map<String, dynamic> changes;
  final DateTime? expectedUpdatedAt;
  final String? reason;
  final String clientActionId;
  Map<String, dynamic> toJson() => {
        'expectedUpdatedAt': expectedUpdatedAt?.toUtc().toIso8601String(),
        'changes': changes,
        'reason': reason,
        'clientActionId': clientActionId,
      };
}

class CampaignAction {
  CampaignAction({required this.endNow, required this.reason, String? clientActionId}) : clientActionId = clientActionId ?? _uuid.v4();
  final bool endNow;
  final String reason;
  final String clientActionId;
  Map<String, dynamic> toJson() => {'action': endNow ? 'end_now' : 'cancel', 'reason': reason, 'clientActionId': clientActionId};
}

/// The fields of [next] that differ from [before] (wire form). A started
/// campaign may only change its end, budget, notes and banner.
Map<String, dynamic> campaignChanges(CampaignInput before, CampaignInput next, {bool windowOnly = false}) {
  final a = before.toJson(), b = next.toJson();
  const lockedAfterStart = {'endsAt', 'budget', 'notes', 'banner'};
  bool same(Object? x, Object? y) {
    if (x is List && y is List) return x.length == y.length && x.toSet().containsAll(y);
    if (x is Map && y is Map) return x.length == y.length && x.keys.every((k) => same(x[k], y[k]));
    return x == y;
  }

  return {
    for (final k in b.keys)
      // The kind, the request and the zone never change after creation.
      if (k != 'kind' && k != 'requestId' && k != 'zoneId' && !same(a[k], b[k]) && (!windowOnly || lockedAfterStart.contains(k))) k: b[k],
  };
}
