import '../core/options.dart';
import '../core/pricing.dart';

int _int(Object? v, [int fallback = 0]) =>
    v is num ? v.round() : int.tryParse('$v') ?? fallback;

double? _double(Object? v) =>
    v is num ? v.toDouble() : (v == null ? null : double.tryParse('$v'));

DateTime? _date(Object? v) => v == null ? null : DateTime.tryParse('$v');

class MenuItem implements OptionChoiceItem {
  const MenuItem({
    required this.id,
    required this.uuid,
    required this.name,
    required this.description,
    required this.price,
    required this.discountPrice,
    required this.category,
    required this.veg,
    required this.image,
    required this.available,
    required this.popular,
    this.variants = const [],
    this.addonGroups = const [],
    this.stockLeft,
    this.availableDays,
    this.availableFrom,
    this.availableTo,
  });

  /// What `/api/orders` expects as `itemId`: `external_id ?? id`, exactly as
  /// the website's catalog exposes it (restaurants.ts `mapMenuItem`).
  final String id;

  /// The row's primary key, for the popularity RPC.
  final String uuid;
  final String name;
  final String description;
  final int price;
  final int? discountPrice;
  final String category;
  final bool veg;
  final String? image;
  final bool available;
  final bool popular;

  /// Sizes (one must be picked; its price replaces [price]) — 0062.
  @override
  final List<MenuOption> variants;

  /// Add-on groups (pick between min and max) — 0062.
  @override
  final List<MenuAddonGroup> addonGroups;

  /// Units left when the shop counts stock; null = not counted.
  final int? stockLeft;

  /// IST weekdays offered (0 = Sunday) and an "HH:MM" window; null = always.
  final List<int>? availableDays;
  final String? availableFrom;
  final String? availableTo;

  @override
  int get effective => effectivePrice(price, discountPrice);

  bool get offered => offeredNow(days: availableDays, from: availableFrom, to: availableTo);

  /// The cheapest size on offer, or the effective price.
  int get fromPrice {
    final sizes = variants.where((v) => v.available).map((v) => v.price);
    return sizes.isEmpty ? effective : sizes.reduce((a, b) => a < b ? a : b);
  }
  bool get onSale => effective < price;

  factory MenuItem.fromRow(Map<String, dynamic> r, {Set<String>? topSellers}) {
    final uuid = '${r['id']}';
    final ranked = topSellers != null;
    return MenuItem(
      id: (r['external_id'] as String?) ?? uuid,
      uuid: uuid,
      name: '${r['name'] ?? ''}',
      description: '${r['description'] ?? ''}',
      price: _int(r['price']),
      discountPrice: r['discount_price'] == null ? null : _int(r['discount_price']),
      category: (r['category'] as String?)?.trim().isNotEmpty == true
          ? r['category'] as String
          : 'Popular',
      veg: r['veg'] == true,
      image: (r['image_url'] as String?)?.isNotEmpty == true ? r['image_url'] as String : null,
      available: r['available'] != false,
      popular: ranked
          ? topSellers.contains(uuid)
          : r['popular'] == true || r['bestseller'] == true,
      variants: sortedRows(r['menu_item_variants']).map(MenuOption.fromRow).toList(),
      addonGroups: sortedRows(r['menu_item_addon_groups']).map(MenuAddonGroup.fromRow).toList(),
      stockLeft: r['stock_qty'] == null ? null : _int(r['stock_qty']),
      availableDays: (r['available_days'] as List?)?.map((d) => _int(d)).toList(),
      availableFrom: (r['available_from'] as String?)?.substring(0, 5),
      availableTo: (r['available_to'] as String?)?.substring(0, 5),
    );
  }
}

class Restaurant {
  const Restaurant({
    required this.id,
    required this.slug,
    required this.name,
    required this.tagline,
    required this.cuisines,
    required this.rating,
    required this.ratingCount,
    required this.pace,
    required this.priceTier,
    required this.costForTwo,
    required this.lat,
    required this.lng,
    required this.address,
    required this.offer,
    required this.promoted,
    required this.open,
    required this.image,
    required this.accentTint,
    required this.sortPosition,
    this.menu = const [],
    this.status,
    this.openingTime,
  });

  final String id;
  final String slug;
  final String name;
  final String tagline;
  final List<String> cuisines;
  final double rating;
  final int ratingCount;
  final KitchenPace pace;
  final int priceTier;
  final int costForTwo;
  final double? lat;
  final double? lng;
  final String? address;

  /// Null once the campaign behind the badge has lapsed.
  final String? offer;
  final bool promoted;

  /// Taking orders right now: the owner's switch, and since 0062 also the
  /// shop's hours, weekly off, holidays and a timed pause.
  final bool open;

  /// Why it is or isn't (restaurant_status_now); null before 0062.
  final String? status;

  /// "HH:MM", for "opens at …".
  final String? openingTime;
  final String image;
  final String accentTint;
  final int? sortPosition;
  final List<MenuItem> menu;

  int get etaMin => pace.etaMin;
  int get etaMax => pace.etaMax;

  /// Category tabs: "Popular" first when it has dishes, then menu order.
  List<String> get categories {
    final hasPopular = menu.any((m) => m.popular);
    final seen = <String>{};
    return [
      if (hasPopular) 'Popular',
      for (final m in menu)
        if (m.category != 'Popular' && seen.add(m.category)) m.category,
    ];
  }

  Restaurant withMenu(List<MenuItem> items) => Restaurant(
        id: id,
        slug: slug,
        name: name,
        tagline: tagline,
        cuisines: cuisines,
        rating: rating,
        ratingCount: ratingCount,
        pace: pace,
        priceTier: priceTier,
        costForTwo: costForTwo,
        lat: lat,
        lng: lng,
        address: address,
        offer: offer,
        promoted: promoted,
        open: open,
        image: image,
        accentTint: accentTint,
        sortPosition: sortPosition,
        menu: items,
        status: status,
        openingTime: openingTime,
      );

  factory Restaurant.fromRow(Map<String, dynamic> r, {Set<String>? topSellers, String? status}) {
    final offerExpires = _date(r['offer_expires_at']);
    final offer = r['offer'] as String?;
    final menuRows = (r['menu_items'] as List?) ?? const [];
    return Restaurant(
      id: '${r['id']}',
      slug: '${r['slug']}',
      name: '${r['name'] ?? ''}',
      tagline: '${r['tagline'] ?? ''}',
      cuisines: ((r['cuisines'] as List?) ?? const []).map((c) => '$c').toList(),
      rating: _double(r['rating']) ?? 0,
      ratingCount: _int(r['rating_count']),
      pace: kitchenPace(
        etaMin: r['eta_min'] == null ? null : _int(r['eta_min']),
        etaMax: r['eta_max'] == null ? null : _int(r['eta_max']),
        busyUntil: _date(r['busy_until']),
        busyExtraMinutes:
            r['busy_extra_minutes'] == null ? null : _int(r['busy_extra_minutes']),
      ),
      priceTier: _int(r['price_tier'], 1),
      costForTwo: _int(r['cost_for_two'], 400),
      lat: _double(r['lat']),
      lng: _double(r['lng']),
      address: r['address'] as String?,
      offer: offer != null &&
              offer.isNotEmpty &&
              (offerExpires == null || offerExpires.isAfter(DateTime.now()))
          ? offer
          : null,
      promoted: r['promoted'] == true,
      // The live answer when 0062 can give it; the owner's switch before.
      open: status != null ? status == 'open' : r['is_open'] == true,
      status: status,
      openingTime: (r['opening_time'] as String?)?.substring(0, 5),
      image: '${r['image_url'] ?? ''}',
      accentTint: (r['accent_tint'] as String?) ??
          'linear-gradient(135deg,#f6c453,#e8552d)',
      sortPosition: r['sort_position'] == null ? null : _int(r['sort_position']),
      menu: [
        for (final m in menuRows)
          MenuItem.fromRow(Map<String, dynamic>.from(m as Map), topSellers: topSellers),
      ],
    );
  }
}
