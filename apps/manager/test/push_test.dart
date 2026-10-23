import 'package:deligro_manager/core/push.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('website order links open that order', () {
    expect(inAppPathFrom('https://deligrodelivery.ractrotech.com/admin/orders/1234abcd-0000-0000-0000-000000000000', null),
        '/orders/1234abcd-0000-0000-0000-000000000000');
  });

  test('the older ops notices open the right screen (review #12)', () {
    const id = '9a1c6a52-7d7f-4f0e-9d8c-2a1f0b6c9e22';
    // A rider's SOS and the desk's ticket links, written with the website's path.
    expect(inAppPathFrom('/manager/support/$id', null), '/more/tickets/$id');
    expect(inAppPathFrom(null, {'url': '/admin/support/$id'}), '/more/tickets/$id');
    expect(inAppPathFrom('/manager/cash', null), '/more/cash');
  });

  test('an inbox row opens its own link, else its alert, else the mapped old link', () {
    const id = '9a1c6a52-7d7f-4f0e-9d8c-2a1f0b6c9e22';
    expect(inboxPath(url: '/orders/$id', alertId: null, data: {'url': '/orders/$id'}), '/orders/$id');
    expect(inboxPath(url: null, alertId: 'al-12345', data: {'alertId': 'al-12345'}), '/alerts/al-12345');
    expect(inboxPath(url: '/manager/support/$id', alertId: null, data: {'url': '/manager/support/$id'}), '/more/tickets/$id');
    expect(inboxPath(url: '/manager', alertId: null, data: {'url': '/manager'}), '/');
    expect(inboxPath(url: 'https://evil.example/x', alertId: null, data: {'url': 'https://evil.example/x'}), isNull);
    expect(inboxPath(url: null, alertId: null, data: const {}), isNull);
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
