import '../models/vendor_me.dart';

/// The shop switches (Admin → Feature access; src/lib/features/catalog.ts)
/// that hide whole sections of the Partner app. Each section is hidden here
/// and its `/api/vendor/*` routes refuse it with 403 feature_disabled, so the
/// app hiding it is presentation, not the guard.
///
/// Orders are not here and never will be: seeing and accepting orders is the
/// job, not a feature.
const earningsFeature = 'vendor.earnings';
const reportsFeature = 'vendor.reports';
const promotionsFeature = 'vendor.promotions';
const marketingFeature = 'vendor.marketing';
const reviewsFeature = 'vendor.reviews';
const supportFeature = 'vendor.support';

/// Route prefixes and the switch each sits behind.
const _gated = <(String, String)>[
  ('/payments', earningsFeature),
  ('/reports', reportsFeature),
  ('/more/offers', promotionsFeature),
  ('/more/marketing', marketingFeature),
  ('/more/reviews', reviewsFeature),
  ('/more/support', supportFeature),
];

/// The switch [path] sits behind, or null when no switch governs it.
String? featureForPath(String path) {
  for (final (prefix, feature) in _gated) {
    if (path == prefix || path.startsWith('$prefix/')) return feature;
  }
  return null;
}

/// Where a deep link (a push, a notification row, a stale tab) into a section
/// switched off for this shop goes: Home. Null when it may open.
String? featureRedirect(String path, VendorMe me) {
  final feature = featureForPath(path);
  if (feature == null || me.can(feature)) return null;
  return '/';
}
