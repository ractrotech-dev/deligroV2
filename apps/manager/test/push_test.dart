import 'package:deligro_manager/core/push.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('website order links open that order', () {
    expect(inAppPathFrom('https://deligrodelivery.ractrotech.com/admin/orders/1234abcd-0000-0000-0000-000000000000', null),
        '/orders/1234abcd-0000-0000-0000-000000000000');
  });

  test('a deep path a tab has no route for opens the tab', () {
    expect(inAppPathFrom(null, {'appPath': '/orders/1234abcd-0000-0000-0000-000000000000/extra'}), '/orders');
    expect(inAppPathFrom(null, {'appPath': '/live/rider/42'}), '/live');
    expect(inAppPathFrom(null, {'appPath': '/finance/ledger/2026'}), '/finance');
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
