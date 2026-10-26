import '../models/rider_me.dart';

/// The `/api/rider/me` switches (Admin → Feature access;
/// src/lib/features/catalog.ts) that hide a section away from the tab bar.
/// Earnings and History are whole tabs and keep their own redirects
/// (earnings_screen.dart, history_screen.dart).
///
/// Each section is also refused by its `/api/rider/*` routes with 403
/// feature_disabled, so hiding it here is presentation, not the guard.
///
/// Nothing that is the job or the rider's safety is here: going online,
/// offers, the delivery screen, cash collection on a delivery, SOS, the
/// incident reports and calling Deligro have no switch.
const cashFeature = 'driver.cash';
const incentivesFeature = 'driver.incentives';
const performanceFeature = 'driver.performance';
const supportFeature = 'driver.support';

/// Route prefixes, the switch each sits behind, and where a link to it goes
/// while the switch is off.
const _gated = <(String, String, String)>[
  ('/more/cash', cashFeature, '/more'),
  ('/more/performance', performanceFeature, '/more'),
  ('/earnings/incentives', incentivesFeature, '/earnings'),
  // Help itself stays (Deligro's numbers, the questions); the tickets go.
  ('/more/help/new', supportFeature, '/more/help'),
  ('/more/help/tickets', supportFeature, '/more/help'),
];

/// Where a deep link (a push, a notification row, a stale back stack) into a
/// section switched off for this rider goes. Null when it may open.
String? featureRedirect(String path, RiderMe? me) {
  if (me == null) return null;
  for (final (prefix, feature, home) in _gated) {
    if ((path == prefix || path.startsWith('$prefix/')) && !me.feature(feature)) return home;
  }
  return null;
}
