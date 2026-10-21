import 'dart:math';

/// The Bemetara launch centre (src/lib/location/pinned.ts). Used when the
/// customer has no location yet — the same origin the website falls back to.
const pinnedLat = 21.7157;
const pinnedLng = 81.5335;
const pinnedLabel = 'Bemetara';

double haversineKm(double lat1, double lng1, double lat2, double lng2) {
  const r = 6371.0;
  double rad(double d) => d * pi / 180;
  final dLat = rad(lat2 - lat1);
  final dLng = rad(lng2 - lng1);
  final a = sin(dLat / 2) * sin(dLat / 2) +
      cos(rad(lat1)) * cos(rad(lat2)) * sin(dLng / 2) * sin(dLng / 2);
  return 2 * r * asin(sqrt(a));
}
