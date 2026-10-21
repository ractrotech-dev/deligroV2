import 'package:uuid/uuid.dart';

import 'json_util.dart';
import 'orders.dart' show VendorRef;

/// Products as `/api/manager/products*` sends them (Phase 4 plan, "API
/// contract"). Enums parse leniently.

enum ApprovalStatus {
  approved('Approved'),
  pending('Waiting for approval'),
  rejected('Rejected'),
  unknown('Unknown');

  const ApprovalStatus(this.label);
  final String label;

  static ApprovalStatus parse(Object? s) => jEnum(values, s, unknown);
}

enum ChangeSource {
  vendor('vendor'),
  ops('Deligro'),
  admin('admin'),
  system('system'),
  unknown('unknown');

  const ChangeSource(this.label);
  final String label;

  static ChangeSource parse(Object? s) => jEnum(values, s, unknown);
}

enum FlagReason {
  inaccurate('inaccurate', 'Inaccurate description'),
  inappropriate('inappropriate', 'Inappropriate content'),
  wrongImage('wrong_image', 'Wrong image'),
  wrongPrice('wrong_price', 'Wrong price'),
  wrongCategory('wrong_category', 'Wrong category'),
  other('other', 'Other'),
  unknown('unknown', 'Unknown');

  const FlagReason(this.wire, this.label);
  final String wire;
  final String label;

  static FlagReason parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
  static const pickable = [inaccurate, inappropriate, wrongImage, wrongPrice, wrongCategory, other];
}

enum FlagStatus {
  open('Open'),
  resolved('Resolved'),
  dismissed('Dismissed'),
  unknown('Unknown');

  const FlagStatus(this.label);
  final String label;

  static FlagStatus parse(Object? s) => jEnum(values, s, unknown);
}

class ProductListItem {
  const ProductListItem({
    required this.id,
    required this.name,
    required this.vendor,
    this.category,
    this.price = 0,
    this.discountPrice,
    this.pendingPrice,
    this.imageUrl,
    this.veg,
    this.available = true,
    this.stockQty,
    this.lowStockAt,
    this.soldOutByStock = false,
    this.approvalStatus = ApprovalStatus.approved,
    this.hidden = false,
    this.openFlags = 0,
    this.updatedAt,
  });

  factory ProductListItem.fromJson(Map<String, dynamic> j) {
    final v = jRef(j['vendor']);
    return ProductListItem(
      id: jStrOr(j['id']),
      name: jStrOr(j['name']),
      vendor: VendorRef(id: v?.id ?? '', name: v?.name ?? ''),
      category: jStr(j['category']),
      price: jInt(j['price']),
      discountPrice: jIntOrNull(j['discountPrice']),
      pendingPrice: jIntOrNull(j['pendingPrice']),
      imageUrl: jStr(j['imageUrl']),
      veg: j['veg'] is bool ? j['veg'] as bool : null,
      available: j['available'] != false,
      stockQty: jIntOrNull(j['stockQty']),
      lowStockAt: jIntOrNull(j['lowStockAt']),
      soldOutByStock: jBool(j['soldOutByStock']),
      approvalStatus: ApprovalStatus.parse(j['approvalStatus']),
      hidden: jBool(j['hidden']),
      openFlags: jInt(j['openFlags']),
      updatedAt: jDate(j['updatedAt']),
    );
  }

  final String id;
  final String name;
  final VendorRef vendor;
  final String? category;
  final int price;
  final int? discountPrice;

  /// A price change on a restricted dish, waiting for approval; [price] is
  /// still what customers pay.
  final int? pendingPrice;
  final String? imageUrl;
  final bool? veg;
  final bool available;

  /// Null = stock not tracked.
  final int? stockQty;
  final int? lowStockAt;
  final bool soldOutByStock;
  final ApprovalStatus approvalStatus;
  final bool hidden;
  final int openFlags;
  final DateTime? updatedAt;

  bool get stockTracked => stockQty != null;
  bool get outOfStock => soldOutByStock || (stockQty != null && stockQty! <= 0);
  bool get lowStock => !outOfStock && stockQty != null && lowStockAt != null && stockQty! <= lowStockAt!;

  /// "12 left", "Not tracked", "Sold out".
  String get stockWords => !stockTracked
      ? 'Not tracked'
      : outOfStock
          ? 'Sold out'
          : '$stockQty left';
}

class ProductCounts {
  const ProductCounts({
    this.unavailable = 0,
    this.outOfStock = 0,
    this.lowStock = 0,
    this.pendingApproval = 0,
    this.openFlags = 0,
    this.hidden = 0,
  });

  factory ProductCounts.fromJson(Map<String, dynamic>? j) => ProductCounts(
        unavailable: jInt(j?['unavailable']),
        outOfStock: jInt(j?['outOfStock']),
        lowStock: jInt(j?['lowStock']),
        pendingApproval: jInt(j?['pendingApproval']),
        openFlags: jInt(j?['openFlags']),
        hidden: jInt(j?['hidden']),
      );

  final int unavailable;
  final int outOfStock;
  final int lowStock;
  final int pendingApproval;
  final int openFlags;
  final int hidden;
}

class ProductPage {
  const ProductPage({required this.items, this.nextCursor, this.counts = const ProductCounts()});
  factory ProductPage.fromJson(Map<String, dynamic> j) => ProductPage(
        items: [for (final p in jMaps(j['items'])) ProductListItem.fromJson(p)],
        nextCursor: jStr(j['nextCursor']),
        counts: j['counts'] is Map ? ProductCounts.fromJson(jMap(j['counts'])) : null,
      );
  final List<ProductListItem> items;
  final String? nextCursor;

  /// The first page's counts; null on a cursor page (the same list, so the
  /// first page's counts stand).
  final ProductCounts? counts;
}

class CategoryRow {
  const CategoryRow({
    required this.name,
    this.itemCount = 0,
    this.unavailableCount = 0,
    this.vendorCount = 0,
    this.restricted = false,
  });

  factory CategoryRow.fromJson(Map<String, dynamic> j) => CategoryRow(
        name: jStrOr(j['name'], 'Uncategorised'),
        itemCount: jInt(j['itemCount']),
        unavailableCount: jInt(j['unavailableCount']),
        vendorCount: jInt(j['vendorCount']),
        restricted: jBool(j['restricted']),
      );

  final String name;
  final int itemCount;
  final int unavailableCount;
  final int vendorCount;
  final bool restricted;
}

List<CategoryRow> parseCategories(Map<String, dynamic> j) =>
    [for (final c in jMaps(j['categories'])) CategoryRow.fromJson(c)];

class ChangeActor {
  const ChangeActor({required this.id, required this.name, required this.role});
  final String id;
  final String name;
  final String role;
}

class ProductChange {
  const ProductChange({
    required this.id,
    required this.field,
    this.from,
    this.to,
    this.source = ChangeSource.unknown,
    this.actor,
    this.at,
  });

  factory ProductChange.fromJson(Map<String, dynamic> j) {
    final a = jMap(j['actor']);
    return ProductChange(
      id: jInt(j['id']),
      field: jStrOr(j['field']),
      from: _wireText(j['from']),
      to: _wireText(j['to']),
      source: ChangeSource.parse(j['source']),
      actor: a == null ? null : ChangeActor(id: jStrOr(a['id']), name: jStrOr(a['name']), role: jStrOr(a['role'])),
      at: jDate(j['at']),
    );
  }

  static String? _wireText(Object? v) => v == null ? null : '$v';

  final int id;
  final String field;
  final String? from;
  final String? to;
  final ChangeSource source;
  final ChangeActor? actor;
  final DateTime? at;

  static const _fieldWords = {
    'price': 'Price',
    'discount_price': 'Offer price',
    'available': 'Availability',
    'name': 'Name',
    'image_url': 'Image',
    'category': 'Category',
    'approval_status': 'Approval',
    'hidden_by_ops': 'Hidden by Deligro',
    'stock_qty': 'Stock',
  };

  String get fieldLabel => _fieldWords[field] ?? field;

  /// One value in words ("₹180", "Available", "Not tracked", …).
  String valueWords(String? v) {
    if (v == null || v.isEmpty) {
      return switch (field) {
        'stock_qty' => 'Not tracked',
        'discount_price' => 'None',
        _ => '—',
      };
    }
    switch (field) {
      case 'price':
      case 'discount_price':
        final n = num.tryParse(v);
        return n == null ? v : '₹${n.round()}';
      case 'available':
        return v == 'true' ? 'Available' : 'Unavailable';
      case 'hidden_by_ops':
        return v == 'true' ? 'Hidden' : 'Visible';
      case 'approval_status':
        return ApprovalStatus.parse(v).label;
      case 'image_url':
        return 'changed';
      default:
        return v;
    }
  }

  /// "Price ₹160 → ₹180".
  String get summary => field == 'image_url' ? 'Image changed' : '$fieldLabel ${valueWords(from)} → ${valueWords(to)}';
}

class ListingFlag {
  const ListingFlag({
    required this.id,
    required this.reason,
    this.note,
    this.status = FlagStatus.open,
    this.raisedByName,
    this.raisedAt,
    this.resolution,
    this.resolvedByName,
    this.resolvedAt,
  });

  factory ListingFlag.fromJson(Map<String, dynamic> j) => ListingFlag(
        id: jStrOr(j['id']),
        reason: FlagReason.parse(j['reason']),
        note: jStr(j['note']),
        status: FlagStatus.parse(j['status']),
        raisedByName: jRef(j['raisedBy'])?.name,
        raisedAt: jDate(j['raisedAt']),
        resolution: jStr(j['resolution']),
        resolvedByName: jRef(j['resolvedBy'])?.name,
        resolvedAt: jDate(j['resolvedAt']),
      );

  final String id;
  final FlagReason reason;
  final String? note;
  final FlagStatus status;
  final String? raisedByName;
  final DateTime? raisedAt;
  final String? resolution;
  final String? resolvedByName;
  final DateTime? resolvedAt;
}

class DailyUnits {
  const DailyUnits(this.date, this.units);
  final String date;
  final int units;
}

class ProductSales {
  const ProductSales({
    this.from = '',
    this.to = '',
    this.units = 0,
    this.revenue = 0,
    this.orders = 0,
    this.rankInVendor,
    this.daily = const [],
  });

  factory ProductSales.fromJson(Map<String, dynamic>? j) => ProductSales(
        from: jStrOr(j?['from']),
        to: jStrOr(j?['to']),
        units: jInt(j?['units']),
        revenue: jInt(j?['revenue']),
        orders: jInt(j?['orders']),
        rankInVendor: jIntOrNull(j?['rankInVendor']),
        daily: [for (final d in jMaps(j?['daily'])) DailyUnits(jStrOr(d['date']), jInt(d['units']))],
      );

  final String from;
  final String to;
  final int units;
  final int revenue;
  final int orders;
  final int? rankInVendor;
  final List<DailyUnits> daily;
}

class ProductAllowed {
  const ProductAllowed({
    this.flag = false,
    this.hide = false,
    this.unhide = false,
    this.approve = false,
    this.reject = false,
    this.adjustStock = false,
  });

  factory ProductAllowed.fromJson(Map<String, dynamic>? j) => ProductAllowed(
        flag: jBool(j?['flag']),
        hide: jBool(j?['hide']),
        unhide: jBool(j?['unhide']),
        approve: jBool(j?['approve']),
        reject: jBool(j?['reject']),
        adjustStock: jBool(j?['adjustStock']),
      );

  final bool flag;
  final bool hide;
  final bool unhide;
  final bool approve;
  final bool reject;
  final bool adjustStock;
}

class Variant {
  const Variant(this.name, this.price);
  final String name;
  final int price;
}

class AddonGroup {
  const AddonGroup(this.name, this.addons);
  final String name;
  final List<Variant> addons;
}

class ProductDetail {
  const ProductDetail({
    required this.item,
    this.description,
    this.variants = const [],
    this.addonGroups = const [],
    this.approvalNote,
    this.hiddenReason,
    this.changes = const [],
    this.flags = const [],
    this.sales = const ProductSales(),
    this.timesUnavailable = 0,
    this.hoursUnavailable = 0,
    this.allowed = const ProductAllowed(),
  });

  factory ProductDetail.fromJson(Map<String, dynamic> j) {
    final avail = jMap(j['availability']);
    final changes = [for (final c in jMaps(j['changes'])) ProductChange.fromJson(c)]
      ..sort((a, b) => (b.at ?? DateTime(0)).compareTo(a.at ?? DateTime(0)));
    return ProductDetail(
      item: ProductListItem.fromJson(j),
      description: jStr(j['description']),
      variants: [for (final v in jMaps(j['variants'])) Variant(jStrOr(v['name']), jInt(v['price']))],
      addonGroups: [
        for (final g in jMaps(j['addonGroups']))
          AddonGroup(jStrOr(g['name']), [for (final a in jMaps(g['addons'])) Variant(jStrOr(a['name']), jInt(a['price']))]),
      ],
      approvalNote: jStr(j['approvalNote']),
      hiddenReason: jStr(j['hiddenReason']),
      changes: changes,
      flags: [for (final f in jMaps(j['flags'])) ListingFlag.fromJson(f)],
      sales: ProductSales.fromJson(jMap(j['sales'])),
      timesUnavailable: jInt(avail?['timesUnavailable']),
      hoursUnavailable: jDouble(avail?['hoursUnavailable']),
      allowed: ProductAllowed.fromJson(jMap(j['allowed'])),
    );
  }

  final ProductListItem item;
  final String? description;
  final List<Variant> variants;
  final List<AddonGroup> addonGroups;
  final String? approvalNote;
  final String? hiddenReason;

  /// Newest first.
  final List<ProductChange> changes;
  final List<ListingFlag> flags;
  final ProductSales sales;
  final int timesUnavailable;
  final double hoursUnavailable;
  final ProductAllowed allowed;

  String get id => item.id;
  String get name => item.name;
}

class InsightRow {
  const InsightRow({required this.product, this.timesUnavailable = 0, this.hoursUnavailable = 0, this.units = 0, this.revenue = 0});
  final ProductListItem product;
  final int timesUnavailable;
  final double hoursUnavailable;
  final int units;
  final int revenue;
}

class PriceChangeRow {
  const PriceChangeRow({required this.product, this.from, this.to, this.changePct, this.at, this.source = ChangeSource.unknown});
  final ProductListItem product;
  final int? from;
  final int? to;
  final double? changePct;
  final DateTime? at;
  final ChangeSource source;
}

class ProductInsights {
  const ProductInsights({
    this.from = '',
    this.to = '',
    this.frequentlyUnavailable = const [],
    this.priceChanges = const [],
    this.topSellers = const [],
    this.slowSellers = const [],
    this.outOfStock = const [],
  });

  factory ProductInsights.fromJson(Map<String, dynamic> j) {
    ProductListItem p(Map<String, dynamic> row) => ProductListItem.fromJson(jMap(row['product']) ?? const {});
    return ProductInsights(
      from: jStrOr(j['from']),
      to: jStrOr(j['to']),
      frequentlyUnavailable: [
        for (final r in jMaps(j['frequentlyUnavailable']))
          InsightRow(product: p(r), timesUnavailable: jInt(r['timesUnavailable']), hoursUnavailable: jDouble(r['hoursUnavailable'])),
      ],
      priceChanges: [
        for (final r in jMaps(j['priceChanges']))
          PriceChangeRow(
            product: p(r),
            from: jIntOrNull(r['from']),
            to: jIntOrNull(r['to']),
            changePct: jDoubleOrNull(r['changePct']),
            at: jDate(r['at']),
            source: ChangeSource.parse(r['source']),
          ),
      ],
      topSellers: [for (final r in jMaps(j['topSellers'])) InsightRow(product: p(r), units: jInt(r['units']), revenue: jInt(r['revenue']))],
      slowSellers: [for (final r in jMaps(j['slowSellers'])) InsightRow(product: p(r), units: jInt(r['units']), revenue: jInt(r['revenue']))],
      outOfStock: [for (final r in jMaps(j['outOfStock'])) ProductListItem.fromJson(r)],
    );
  }

  final String from;
  final String to;
  final List<InsightRow> frequentlyUnavailable;
  final List<PriceChangeRow> priceChanges;
  final List<InsightRow> topSellers;
  final List<InsightRow> slowSellers;
  final List<ProductListItem> outOfStock;
}

class RestrictedCategory {
  const RestrictedCategory({required this.name, this.note, this.createdAt});
  factory RestrictedCategory.fromJson(Map<String, dynamic> j) =>
      RestrictedCategory(name: jStrOr(j['name']), note: jStr(j['note']), createdAt: jDate(j['createdAt']));
  final String name;
  final String? note;
  final DateTime? createdAt;
}

List<RestrictedCategory> parseRestricted(Map<String, dynamic> j) =>
    [for (final c in jMaps(j['categories'])) RestrictedCategory.fromJson(c)];

/// The list's quick tabs (contract filters).
enum ProductQuick {
  unavailable,
  outOfStock,
  lowStock,
  pendingApproval,
  flagged,
  hidden;
}

/// What the Products list asks for. Immutable.
class ProductFilters {
  const ProductFilters({this.q, this.vendorId, this.vendorName, this.category, this.quick, this.zoneId});

  factory ProductFilters.fromUri(Uri uri) {
    final p = uri.queryParameters;
    String? s(String k) => (p[k]?.trim().isEmpty ?? true) ? null : p[k]!.trim();
    final availability = s('availability');
    ProductQuick? quick = switch (availability) {
      'unavailable' => ProductQuick.unavailable,
      'out_of_stock' => ProductQuick.outOfStock,
      'low_stock' => ProductQuick.lowStock,
      _ => null,
    };
    if (s('approval') == 'pending') quick = ProductQuick.pendingApproval;
    if (s('flagged') == 'open') quick = ProductQuick.flagged;
    if (s('hidden') == 'true') quick = ProductQuick.hidden;
    return ProductFilters(q: s('q'), vendorId: s('vendor'), category: s('category'), quick: quick, zoneId: s('zone'));
  }

  final String? q;
  final String? vendorId;

  /// For the filter chip only; not sent.
  final String? vendorName;
  final String? category;
  final ProductQuick? quick;
  final String? zoneId;

  Map<String, String> toQuery() => {
        'q': ?q,
        'vendor': ?vendorId,
        'category': ?category,
        'zone': ?zoneId,
        ...switch (quick) {
          ProductQuick.unavailable => {'availability': 'unavailable'},
          ProductQuick.outOfStock => {'availability': 'out_of_stock'},
          ProductQuick.lowStock => {'availability': 'low_stock'},
          ProductQuick.pendingApproval => {'approval': 'pending'},
          ProductQuick.flagged => {'flagged': 'open'},
          ProductQuick.hidden => {'hidden': 'true'},
          null => const <String, String>{},
        },
      };

  bool get narrowed => q != null || vendorId != null || category != null || quick != null;

  static const _unset = Object();

  ProductFilters copyWith({
    Object? q = _unset,
    Object? vendorId = _unset,
    Object? vendorName = _unset,
    Object? category = _unset,
    Object? quick = _unset,
    Object? zoneId = _unset,
  }) =>
      ProductFilters(
        q: identical(q, _unset) ? this.q : q as String?,
        vendorId: identical(vendorId, _unset) ? this.vendorId : vendorId as String?,
        vendorName: identical(vendorName, _unset) ? this.vendorName : vendorName as String?,
        category: identical(category, _unset) ? this.category : category as String?,
        quick: identical(quick, _unset) ? this.quick : quick as ProductQuick?,
        zoneId: identical(zoneId, _unset) ? this.zoneId : zoneId as String?,
      );

  @override
  bool operator ==(Object other) =>
      other is ProductFilters &&
      other.q == q &&
      other.vendorId == vendorId &&
      other.category == category &&
      other.quick == quick &&
      other.zoneId == zoneId;

  @override
  int get hashCode => Object.hash(q, vendorId, category, quick, zoneId);
}

const _uuid = Uuid();

/// One audited change to a listing. [clientActionId] minted once per intent.
sealed class ProductAction {
  ProductAction({required this.reason, String? clientActionId}) : clientActionId = clientActionId ?? _uuid.v4();
  final String reason;
  final String clientActionId;

  String get wire;

  Map<String, dynamic> toJson() => {'action': wire, 'reason': reason, 'clientActionId': clientActionId};
}

class FlagListing extends ProductAction {
  /// [note] is the manager's optional description of what is wrong.
  FlagListing({required this.flagReason, String? note, super.clientActionId}) : super(reason: note?.trim() ?? '');
  final FlagReason flagReason;
  String? get note => reason.isEmpty ? null : reason;
  @override
  String get wire => 'flag';
  @override
  Map<String, dynamic> toJson() => {
        'action': wire,
        'flagReason': flagReason.wire,
        if (note != null) 'note': note,
        'clientActionId': clientActionId,
      };
}

class HideListing extends ProductAction {
  HideListing({required super.reason, super.clientActionId});
  @override
  String get wire => 'hide';
}

class UnhideListing extends ProductAction {
  UnhideListing({required super.reason, super.clientActionId});
  @override
  String get wire => 'unhide';
}

class ApproveListing extends ProductAction {
  ApproveListing({required super.reason, super.clientActionId});
  @override
  String get wire => 'approve';
}

class RejectListing extends ProductAction {
  RejectListing({required super.reason, super.clientActionId});
  @override
  String get wire => 'reject';
}

class ResolveFlag extends ProductAction {
  ResolveFlag({required this.flagId, required super.reason, super.clientActionId});
  final String flagId;
  @override
  String get wire => 'resolve_flag';
  @override
  Map<String, dynamic> toJson() => {...super.toJson(), 'flagId': flagId};
}

class DismissFlag extends ProductAction {
  DismissFlag({required this.flagId, required super.reason, super.clientActionId});
  final String flagId;
  @override
  String get wire => 'dismiss_flag';
  @override
  Map<String, dynamic> toJson() => {...super.toJson(), 'flagId': flagId};
}

class AdjustStock extends ProductAction {
  /// [stockQty] is the new absolute quantity (≥ 0), or null to stop tracking.
  /// [expectedStockQty] is the count the manager was shown (null = untracked):
  /// if an order or the vendor moved it since, the server answers `stale`.
  AdjustStock({required this.stockQty, required this.expectedStockQty, required super.reason, super.clientActionId})
      : assert(stockQty == null || stockQty >= 0);
  final int? stockQty;
  final int? expectedStockQty;
  @override
  String get wire => 'adjust_stock';
  @override
  Map<String, dynamic> toJson() => {...super.toJson(), 'stockQty': stockQty, 'expectedStockQty': expectedStockQty};
}

/// A vendor's dish photo waiting for a look (§12.7).
class ImageReviewItem {
  const ImageReviewItem({
    required this.changeId,
    required this.product,
    required this.imageUrl,
    required this.changedAt,
    this.previousImageUrl,
    this.changedBy,
  });

  factory ImageReviewItem.fromJson(Map<String, dynamic> j) => ImageReviewItem(
        changeId: jInt(j['changeId']),
        product: ProductListItem.fromJson(jMap(j['product']) ?? const {}),
        previousImageUrl: jStr(j['previousImageUrl']),
        imageUrl: jStrOr(j['imageUrl']),
        changedAt: DateTime.tryParse(jStrOr(j['changedAt'])) ?? DateTime.fromMillisecondsSinceEpoch(0),
        changedBy: jMap(j['changedBy']) == null
            ? null
            : VendorRef(id: jStrOr(jMap(j['changedBy'])!['id']), name: jStrOr(jMap(j['changedBy'])!['name'])),
      );

  final int changeId;
  final ProductListItem product;
  final String? previousImageUrl;
  final String imageUrl;
  final DateTime changedAt;

  /// Who changed it (a VendorRef carries an id and a name).
  final VendorRef? changedBy;
}

class ImageReviewPage {
  const ImageReviewPage({required this.items, this.nextBefore});
  factory ImageReviewPage.fromJson(Map<String, dynamic> j) => ImageReviewPage(
        items: [for (final r in jMaps(j['items'])) ImageReviewItem.fromJson(r)],
        nextBefore: j['nextBefore'] is num ? (j['nextBefore'] as num).toInt() : null,
      );
  final List<ImageReviewItem> items;
  final int? nextBefore;
}

/// What a manager can flag a photo as.
enum ImageFlagReason {
  wrongImage('wrong_image', 'Not this dish'),
  inappropriate('inappropriate', 'Not appropriate');

  const ImageFlagReason(this.wire, this.label);
  final String wire;
  final String label;
}
