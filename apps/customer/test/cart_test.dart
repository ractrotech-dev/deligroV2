import 'package:deligro_customer/core/pricing.dart';
import 'package:deligro_customer/models/order.dart';
import 'package:deligro_customer/models/restaurant.dart';
import 'package:deligro_customer/state/cart.dart';
import 'package:deligro_customer/state/prefs.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

Restaurant shop(String slug) => Restaurant(
      id: slug,
      slug: slug,
      name: slug.toUpperCase(),
      tagline: '',
      cuisines: const [],
      rating: 0,
      ratingCount: 0,
      pace: kitchenPace(),
      priceTier: 1,
      costForTwo: 300,
      lat: null,
      lng: null,
      address: null,
      offer: null,
      promoted: false,
      open: true,
      image: '',
      accentTint: '',
      sortPosition: null,
    );

MenuItem dish(String id, int price, {int? sale}) => MenuItem(
      id: id,
      uuid: id,
      name: id,
      description: '',
      price: price,
      discountPrice: sale,
      category: 'Mains',
      veg: true,
      image: null,
      available: true,
      popular: false,
    );

Future<ProviderContainer> container([Map<String, Object> prefs = const {}]) async {
  SharedPreferences.setMockInitialValues(prefs);
  final p = await SharedPreferences.getInstance();
  final c = ProviderContainer(overrides: [prefsProvider.overrideWithValue(p)]);
  addTearDown(c.dispose);
  return c;
}

void main() {
  test('adds at the sale price and merges repeat adds', () async {
    final c = await container();
    final cart = c.read(cartProvider.notifier);
    cart.add(shop('a'), dish('x', 100, sale: 80));
    cart.add(shop('a'), dish('x', 100, sale: 80));
    final s = c.read(cartProvider);
    expect(s.count, 2);
    expect(s.subtotal, 160);
  });

  test('one shop per basket: a conflict is reported, replace starts over', () async {
    final c = await container();
    final cart = c.read(cartProvider.notifier);
    cart.add(shop('a'), dish('x', 100));
    expect(cart.conflictsWith(shop('b')), isTrue);
    cart.add(shop('b'), dish('y', 50), replace: true);
    final s = c.read(cartProvider);
    expect(s.slug, 'b');
    expect(s.lines.map((l) => l.itemId), ['y']);
  });

  test('decrement to zero removes the line and empties the basket', () async {
    final c = await container();
    final cart = c.read(cartProvider.notifier);
    cart.add(shop('a'), dish('x', 100));
    cart.decrement('x');
    expect(c.read(cartProvider).isEmpty, isTrue);
    expect(c.read(cartProvider).slug, isNull);
  });

  test('quantity is capped at the server limit', () async {
    final c = await container();
    final cart = c.read(cartProvider.notifier);
    cart.add(shop('a'), dish('x', 10));
    for (var i = 0; i < 60; i++) {
      cart.increment('x');
    }
    expect(c.read(cartProvider).count, maxQty);
  });

  test('persists across restarts', () async {
    final c = await container();
    c.read(cartProvider.notifier).add(shop('a'), dish('x', 100));
    final p = await SharedPreferences.getInstance();
    final c2 = ProviderContainer(overrides: [prefsProvider.overrideWithValue(p)]);
    addTearDown(c2.dispose);
    expect(c2.read(cartProvider).subtotal, 100);
  });

  test('reorder uses live prices and drops unavailable dishes', () async {
    final c = await container();
    final order = Order.fromUi({
      'id': 'o',
      'status': 'DELIVERED',
      'restaurantSlug': 'a',
      'restaurantName': 'A',
      'lines': [
        {'itemId': 'x', 'name': 'X', 'qty': 2, 'price': 90},
        {'itemId': 'y', 'name': 'Y', 'qty': 1, 'price': 50},
        {'itemId': '', 'name': 'Gone', 'qty': 1, 'price': 10},
      ],
    });
    final dropped = c.read(cartProvider.notifier).reorder(order, {
      'x': (price: 100, available: true),
      'y': (price: 50, available: false),
    });
    final s = c.read(cartProvider);
    expect(dropped, 2);
    expect(s.subtotal, 200);
    expect(s.slug, 'a');
  });
}
