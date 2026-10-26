import 'package:deligro_rider/core/feature_routes.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:flutter_test/flutter_test.dart';

RiderMe _me([Map<String, bool> features = const {}]) => RiderMe(
  id: 'rider-1',
  availability: RiderAvailabilityDto.offline,
  phase: 'offline',
  features: features,
);

void main() {
  group('featureRedirect (Admin → Feature access)', () {
    test('every section opens while its switch is on, or before /me answers', () {
      for (final path in [
        '/more/cash',
        '/more/cash/collections',
        '/more/performance',
        '/earnings/incentives',
        '/more/help/new',
        '/more/help/tickets/t1',
      ]) {
        expect(featureRedirect(path, _me()), isNull, reason: path);
        expect(featureRedirect(path, null), isNull, reason: path);
      }
    });

    test('a switched-off section sends a deep link to its parent', () {
      final off = _me({
        'driver.cash': false,
        'driver.performance': false,
        'driver.incentives': false,
        'driver.support': false,
      });
      expect(featureRedirect('/more/cash', off), '/more');
      expect(featureRedirect('/more/cash/collections', off), '/more');
      expect(featureRedirect('/more/performance', off), '/more');
      expect(featureRedirect('/earnings/incentives', off), '/earnings');
      expect(featureRedirect('/more/help/new', off), '/more/help');
      expect(featureRedirect('/more/help/tickets/t1', off), '/more/help');
    });

    test('Help itself, Safety and the job are never behind a switch', () {
      final off = _me({
        'driver.cash': false,
        'driver.performance': false,
        'driver.incentives': false,
        'driver.support': false,
      });
      for (final path in ['/more/help', '/safety', '/home', '/jobs', '/more', '/earnings', '/more/cashx']) {
        expect(featureRedirect(path, off), isNull, reason: path);
      }
    });
  });
}
