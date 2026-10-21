/// `/api/vendor/me`: who is signed in, the shops they run, the shop the server
/// is acting on, and the vendor feature switches for it.
class VendorMe {
  const VendorMe({
    required this.profileId,
    required this.fullName,
    required this.phone,
    required this.role,
    required this.shops,
    required this.activeSlug,
    required this.features,
  });

  factory VendorMe.fromJson(Map<String, dynamic> j) {
    final p = (j['profile'] as Map?)?.cast<String, dynamic>() ?? const {};
    return VendorMe(
      profileId: '${p['id'] ?? ''}',
      fullName: (p['fullName'] as String?)?.trim() ?? '',
      phone: (p['phone'] as String?) ?? '',
      role: '${p['role'] ?? ''}',
      shops: [
        for (final s in (j['shops'] as List? ?? const []))
          Shop.fromJson((s as Map).cast<String, dynamic>()),
      ],
      activeSlug: '${j['activeSlug'] ?? ''}',
      features: {
        for (final e in ((j['features'] as Map?) ?? const {}).entries)
          '${e.key}': e.value == true,
      },
    );
  }

  final String profileId;
  final String fullName;
  final String phone;
  final String role;
  final List<Shop> shops;
  final String activeSlug;
  final Map<String, bool> features;

  Shop get activeShop => shops.firstWhere((s) => s.slug == activeSlug, orElse: () => shops.first);

  /// A switch the server didn't send is treated as off: never fail open.
  bool can(String feature) => features[feature] == true;
}

class Shop {
  const Shop({required this.id, required this.slug, required this.name, required this.isOpen, this.prepMinutes = 20});

  factory Shop.fromJson(Map<String, dynamic> j) => Shop(
        id: '${j['id']}',
        slug: '${j['slug']}',
        name: '${j['name'] ?? ''}',
        isOpen: j['isOpen'] == true,
        prepMinutes: (j['prepMinutes'] as num?)?.toInt() ?? 20,
      );

  final String id;
  final String slug;
  final String name;
  final bool isOpen;

  /// The shop's own prep time, or the platform default; preselected on accept.
  final int prepMinutes;
}
