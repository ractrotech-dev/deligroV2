import 'package:deligro_customer/core/push.dart';
import 'package:deligro_customer/models/banner.dart';
import 'package:deligro_customer/models/order.dart';
import 'package:deligro_customer/models/restaurant.dart';
import 'package:deligro_customer/models/tracking.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('Order.fromRow (raw DB / POST /api/orders)', () {
    final row = {
      'id': 'a1b2c3d4-0000-0000-0000-000000000000',
      'status': 'on_the_way',
      'total': 293,
      'delivery_fee': 29,
      'tax_amount': 12,
      'tip': 20,
      'discount': 0,
      'payment_method': 'cod',
      'payment_status': 'pending',
      'created_at': '2026-10-17T10:00:00Z',
      'address': {'label': 'Home', 'line': 'Station Road'},
      'order_items': [
        {'name': 'Biryani', 'qty': 2, 'price': 116, 'menu_items': {'external_id': 'b-1', 'veg': false}},
      ],
      'restaurants': {'slug': 'dhaba', 'name': 'Dhaba', 'eta_min': 25},
    };

    test('maps status, lines, money and address', () {
      final o = Order.fromRow(row);
      expect(o.status, OrderStatus.onTheWay);
      expect(o.subtotal, 232);
      expect(o.lines.single.itemId, 'b-1');
      expect(o.lines.single.veg, isFalse);
      expect(o.address, 'Home · Station Road');
      expect(o.shortId, 'A1B2C3D4');
      expect(o.status.inFlight, isTrue);
      expect(o.status.customerCanCancel, isFalse);
    });

    test('unknown status falls back to placed', () {
      expect(parseStatus('weird'), OrderStatus.placed);
    });
  });

  test('Order.fromUi (camelCase history)', () {
    final o = Order.fromUi({
      'id': 'x',
      'status': 'DELIVERED',
      'restaurantSlug': 's',
      'restaurantName': 'S',
      'createdAt': '2026-10-17T10:00:00Z',
      'total': 100,
      'charges': {'subtotal': 80, 'deliveryFee': 16, 'tax': 4, 'tip': 0, 'discount': 0},
      'lines': [
        {'itemId': 'i', 'name': 'Tea', 'qty': 4, 'price': 20},
      ],
    });
    expect(o.status, OrderStatus.delivered);
    expect(o.subtotal, 80);
    expect(o.lines.single.veg, isNull);
  });

  group('Restaurant.fromRow', () {
    test('item id is external_id ?? uuid (what /api/orders matches)', () {
      final r = Restaurant.fromRow({
        'id': 'r1',
        'slug': 's',
        'name': 'S',
        'is_open': true,
        'menu_items': [
          {'id': 'u1', 'external_id': 'e1', 'name': 'A', 'price': 100, 'discount_price': 80},
          {'id': 'u2', 'external_id': null, 'name': 'B', 'price': 50, 'popular': true},
        ],
      });
      expect(r.menu.map((m) => m.id), ['e1', 'u2']);
      expect(r.menu.first.effective, 80);
      expect(r.categories.first, 'Popular');
    });

    test('a lapsed offer is dropped', () {
      final r = Restaurant.fromRow({
        'id': 'r',
        'slug': 's',
        'name': 'S',
        'offer': '20% OFF',
        'offer_expires_at': '2000-01-01T00:00:00Z',
      });
      expect(r.offer, isNull);
    });
  });

  test('tracking snapshot parses positions and rider', () {
    final t = TrackingSnapshot.fromJson({
      'status': 'ON_THE_WAY',
      'eta': {'minutesRemaining': 9, 'late': false, 'lateByMinutes': 0},
      'rider': {'name': 'Ravi', 'id': 'AB12', 'phone': '+919999999999'},
      'restaurant': {'lat': 21.7, 'lng': 81.5},
      'destination': {'lat': 21.71, 'lng': 81.53},
      'riderPosition': null,
      'riderPositionSource': 'none',
    });
    expect(t.status, OrderStatus.onTheWay);
    expect(t.eta!.minutesRemaining, 9);
    expect(t.rider!.name, 'Ravi');
    expect(t.riderPosition, isNull);
  });

  group('push links', () {
    test('accepts absolute and relative order links', () {
      expect(
        orderPathFrom('https://deligrodelivery.ractrotech.com/orders/3be2e4c7-46d6-4415-98a5-9b341acf17b9', null),
        '/orders/3be2e4c7-46d6-4415-98a5-9b341acf17b9',
      );
      expect(orderPathFrom(null, {'url': '/orders/abcdef12'}), '/orders/abcdef12');
    });

    test('ignores anything that is not an order', () {
      expect(orderPathFrom('https://evil.example/login', null), isNull);
      expect(orderPathFrom('/orders/1/../../profile', null), isNull);
    });
  });

  test('banner routes mirror banner-href.ts', () {
    PromoBanner b(String type, [String? value]) => PromoBanner(
          id: '1',
          headline: '',
          description: null,
          ctaLabel: null,
          targetType: type,
          targetValue: value,
          image: null,
          tint: null,
        );
    expect(b('restaurant', 'burger-republic').route, '/restaurant/burger-republic');
    expect(b('grocery').route, '/stores?category=groceries');
    expect(b('external', 'http://insecure.example').route, isNull);
  });
}
