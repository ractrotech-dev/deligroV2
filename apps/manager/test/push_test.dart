import 'package:deligro_manager/core/push.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // Order detail arrives in Phase 3; until then an order link opens the
  // Orders tab rather than a route that does not exist.
  test('website order links open the Orders tab', () {
    expect(inAppPathFrom('https://deligrodelivery.ractrotech.com/admin/orders/1234abcd-0000-0000-0000-000000000000', null),
        '/orders');
  });

  test('a deep path under a tab with no sub-routes opens the tab', () {
    expect(inAppPathFrom(null, {'appPath': '/orders/1234abcd-0000-0000-0000-000000000000'}), '/orders');
    expect(inAppPathFrom(null, {'appPath': '/live/rider/42'}), '/live');
    expect(inAppPathFrom(null, {'appPath': '/finance/settlements'}), '/finance');
  });

  test('the website manager board opens Home', () {
    expect(inAppPathFrom(null, {'url': '/manager'}), '/');
  });

  test('an explicit in-app path wins', () {
    expect(inAppPathFrom('/manager', {'appPath': '/more/support'}), '/more/support');
  });

  test('anything else is ignored rather than followed', () {
    expect(inAppPathFrom('https://evil.example/phish', null), isNull);
    expect(inAppPathFrom('/login', null), isNull);
    expect(inAppPathFrom(null, {'url': 'javascript:alert(1)'}), isNull);
  });
}
