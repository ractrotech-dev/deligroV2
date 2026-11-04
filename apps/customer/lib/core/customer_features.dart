/// The customer switches (Admin → App features; src/lib/features/catalog.ts). The
/// server sends them on `GET /api/me`, this app hides what is off, and the routes
/// behind each one refuse on their own: hiding is presentation, not the guard.
///
/// Browsing, search, placing an order and tracking are not here and never will be:
/// they are the job, not a feature.
const promoCodesFeature = 'customer.promo_codes';
const tipsFeature = 'customer.tips';
const deliveryNotesFeature = 'customer.delivery_notes';
const reorderFeature = 'customer.reorder';
const cancelFeature = 'customer.cancel';
const reviewsFeature = 'customer.reviews';
const rateRiderFeature = 'customer.rate_rider';
const favoritesFeature = 'customer.favorites';
const savedAddressesFeature = 'customer.saved_addresses';
const profileEditFeature = 'customer.profile_edit';
const walletFeature = 'customer.wallet';

/// Off until the server says otherwise. Mirrors `defaultOn: false` in the catalog.
const _offUntilSaid = {'customer.self_pickup'};

class CustomerFeatures {
  const CustomerFeatures([this._known = const {}]);

  /// `/api/me`'s `features`. A server that sent none leaves everything unknown.
  factory CustomerFeatures.fromMe(Map<String, dynamic> me) {
    final raw = me['features'];
    if (raw is! Map) return unknown;
    return CustomerFeatures({for (final e in raw.entries) '${e.key}': e.value == true});
  }

  /// Before the first answer, or if it never comes. Each feature at its default, so
  /// no network blip takes the Cancel button away in its 20 seconds. If it was
  /// actually off, the server refuses and says why.
  static const unknown = CustomerFeatures();

  final Map<String, bool> _known;

  bool can(String feature) => _known[feature] ?? !_offUntilSaid.contains(feature);
}

/// Pages a switch hides entirely, for a deep link or a stale tab.
const _gated = <(String, String)>[
  ('/profile/favorites', favoritesFeature),
  ('/profile/addresses', savedAddressesFeature),
  ('/profile/wallet', walletFeature),
];

/// Where a path behind a switched-off feature goes: back to Account. Null when it
/// may open.
String? featureRedirect(String path, CustomerFeatures features) {
  for (final (prefix, feature) in _gated) {
    if ((path == prefix || path.startsWith('$prefix/')) && !features.can(feature)) return '/profile';
  }
  return null;
}
