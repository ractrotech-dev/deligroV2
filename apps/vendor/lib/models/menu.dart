/// `/api/vendor/menu` (src/lib/vendor/menu-json.ts).
class MenuItem {
  const MenuItem({
    required this.id,
    required this.name,
    this.description = '',
    required this.price,
    required this.category,
    required this.veg,
    this.available = true,
    this.popular = false,
    this.bestseller = false,
    this.imageUrl,
    this.sortOrder = 0,
    this.soldCount = 0,
    this.soldRevenue = 0,
    this.stockQty,
    this.lowStockAt,
    this.soldOutByStock = false,
    this.availableDays,
    this.availableFrom,
    this.availableTo,
    this.variants = const [],
    this.addonGroups = const [],
  });

  factory MenuItem.fromJson(Map<String, dynamic> j) => MenuItem(
    id: j['id'] as String,
    name: j['name'] as String? ?? '',
    description: j['description'] as String? ?? '',
    price: (j['price'] as num?)?.round() ?? 0,
    category: j['category'] as String? ?? 'Popular',
    veg: j['veg'] == true,
    available: j['available'] != false,
    popular: j['popular'] == true,
    bestseller: j['bestseller'] == true,
    imageUrl: j['imageUrl'] as String?,
    sortOrder: (j['sortOrder'] as num?)?.toInt() ?? 0,
    soldCount: (j['soldCount'] as num?)?.round() ?? 0,
    soldRevenue: (j['soldRevenue'] as num?)?.round() ?? 0,
    stockQty: (j['stockQty'] as num?)?.toInt(),
    lowStockAt: (j['lowStockAt'] as num?)?.toInt(),
    soldOutByStock: j['soldOutByStock'] == true,
    availableDays: (j['availableDays'] as List?)?.map((d) => (d as num).toInt()).toList(),
    availableFrom: j['availableFrom'] as String?,
    availableTo: j['availableTo'] as String?,
    variants: [
      for (final v in (j['variants'] as List? ?? const [])) MenuOption.fromJson((v as Map).cast<String, dynamic>()),
    ],
    addonGroups: [
      for (final g in (j['addonGroups'] as List? ?? const [])) AddonGroup.fromJson((g as Map).cast<String, dynamic>()),
    ],
  );

  final String id;
  final String name;
  final String description;
  final int price;
  final String category;
  final bool veg;
  final bool available;
  final bool popular;
  final bool bestseller;
  final String? imageUrl;
  final int sortOrder;
  final int soldCount;
  final int soldRevenue;

  /// Units left; null = not tracked.
  final int? stockQty;
  final int? lowStockAt;

  /// Stock reached 0 and turned the item off; restocking turns it back on.
  final bool soldOutByStock;

  /// Weekdays offered, 0 = Sunday; null = every day.
  final List<int>? availableDays;
  final String? availableFrom;
  final String? availableTo;
  final List<MenuOption> variants;
  final List<AddonGroup> addonGroups;

  bool get tracksStock => stockQty != null;
  bool get outOfStock => stockQty == 0;

  /// At or under its alert level, but not yet out.
  bool get lowStock => stockQty != null && stockQty! > 0 && lowStockAt != null && stockQty! <= lowStockAt!;
  bool get scheduled => availableDays != null || (availableFrom != null && availableTo != null);
  bool get hasOptions => variants.isNotEmpty || addonGroups.isNotEmpty;

  /// The lowest price a customer can pay: the cheapest size when there are sizes.
  int get fromPrice {
    final live = variants.where((v) => v.available).map((v) => v.price);
    return live.isEmpty ? price : live.reduce((a, b) => a < b ? a : b);
  }
}

/// A size (variant) or an add-on: a name and a price.
class MenuOption {
  const MenuOption({this.id, required this.name, required this.price, this.available = true});

  factory MenuOption.fromJson(Map<String, dynamic> j) => MenuOption(
    id: j['id'] as String?,
    name: j['name'] as String? ?? '',
    price: (j['price'] as num?)?.round() ?? 0,
    available: j['available'] != false,
  );

  final String? id;
  final String name;
  final int price;
  final bool available;

  Map<String, dynamic> toJson() => {'id': ?id, 'name': name, 'price': price, 'available': available};
}

class AddonGroup {
  const AddonGroup({this.id, required this.name, this.minSelect = 0, this.maxSelect = 1, this.addons = const []});

  factory AddonGroup.fromJson(Map<String, dynamic> j) => AddonGroup(
    id: j['id'] as String?,
    name: j['name'] as String? ?? '',
    minSelect: (j['minSelect'] as num?)?.toInt() ?? 0,
    maxSelect: (j['maxSelect'] as num?)?.toInt() ?? 1,
    addons: [
      for (final a in (j['addons'] as List? ?? const [])) MenuOption.fromJson((a as Map).cast<String, dynamic>()),
    ],
  );

  final String? id;
  final String name;
  final int minSelect;
  final int maxSelect;
  final List<MenuOption> addons;

  Map<String, dynamic> toJson() => {
    'id': ?id,
    'name': name,
    'minSelect': minSelect,
    'maxSelect': maxSelect,
    'addons': [for (final a in addons) a.toJson()],
  };
}

/// The whole `/api/vendor/menu` answer.
class Menu {
  const Menu({
    required this.restaurantId,
    required this.categories,
    required this.items,
    required this.inventorySupported,
    required this.canEdit,
  });

  factory Menu.fromJson(Map<String, dynamic> j) => Menu(
    restaurantId: j['restaurantId'] as String,
    categories: [for (final c in (j['categories'] as List? ?? const [])) '$c'],
    items: [for (final i in (j['items'] as List? ?? const [])) MenuItem.fromJson((i as Map).cast<String, dynamic>())],
    inventorySupported: j['inventorySupported'] == true,
    canEdit: j['canEdit'] != false,
  );

  final String restaurantId;
  final List<String> categories;
  final List<MenuItem> items;

  /// False until the server has migration 0062: stock, schedules and options hide.
  final bool inventorySupported;
  final bool canEdit;

  int get lowStockCount => items.where((i) => i.lowStock || i.outOfStock).length;
}
