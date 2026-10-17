class PromoBanner {
  const PromoBanner({
    required this.id,
    required this.headline,
    required this.description,
    required this.ctaLabel,
    required this.targetType,
    required this.targetValue,
    required this.image,
    required this.tint,
  });

  final String id;
  final String headline;
  final String? description;
  final String? ctaLabel;
  final String targetType;
  final String? targetValue;
  final String? image;
  final String? tint;

  static const columns =
      'id, headline, description, cta_label, target_type, target_value, '
      'image_url, mobile_image_url, tint, priority, display_order';

  factory PromoBanner.fromRow(Map<String, dynamic> r) => PromoBanner(
        id: '${r['id']}',
        headline: '${r['headline'] ?? ''}',
        description: r['description'] as String?,
        ctaLabel: r['cta_label'] as String?,
        targetType: '${r['target_type'] ?? 'food'}',
        targetValue: r['target_value'] as String?,
        image: (r['mobile_image_url'] as String?) ?? (r['image_url'] as String?),
        tint: r['tint'] as String?,
      );

  /// In-app route for the banner, mirroring src/lib/banner-href.ts. External
  /// links come back as an absolute https URL; null = nowhere to go.
  String? get route {
    final v = targetValue;
    switch (targetType) {
      case 'food':
        return '/';
      case 'grocery':
        return '/stores?category=groceries';
      case 'pick_drop':
        return '/stores?category=pick-drop';
      case 'shops':
      case 'store':
        return '/stores';
      case 'restaurant':
        return v == null || v.isEmpty ? '/' : '/restaurant/$v';
      case 'category':
        return v == null || v.isEmpty ? '/search' : '/search?category=${Uri.encodeComponent(v)}';
      case 'external':
        return v != null && v.startsWith('https://') ? v : null;
      default:
        return null;
    }
  }
}
