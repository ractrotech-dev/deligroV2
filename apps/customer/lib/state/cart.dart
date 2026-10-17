import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/order.dart';
import '../models/restaurant.dart';
import 'prefs.dart';

class CartLine {
  const CartLine({
    required this.itemId,
    required this.name,
    required this.price,
    required this.qty,
    this.veg,
  });

  final String itemId;
  final String name;

  /// The effective (discounted) unit price at the time it was added. Only a
  /// preview: `/api/orders` re-prices from `menu_items`.
  final int price;
  final int qty;
  final bool? veg;

  CartLine copyWith({int? qty, int? price}) => CartLine(
        itemId: itemId,
        name: name,
        price: price ?? this.price,
        qty: qty ?? this.qty,
        veg: veg,
      );

  Map<String, dynamic> toJson() =>
      {'itemId': itemId, 'name': name, 'price': price, 'qty': qty, 'veg': veg};

  factory CartLine.fromJson(Map<String, dynamic> j) => CartLine(
        itemId: '${j['itemId']}',
        name: '${j['name']}',
        price: (j['price'] as num).round(),
        qty: (j['qty'] as num).round(),
        veg: j['veg'] as bool?,
      );
}

/// One restaurant per basket, as on the web (stores/cart-store.ts).
class CartState {
  const CartState({this.slug, this.restaurantName, this.lines = const []});

  final String? slug;
  final String? restaurantName;
  final List<CartLine> lines;

  bool get isEmpty => lines.isEmpty;
  int get count => lines.fold(0, (s, l) => s + l.qty);
  int get subtotal => lines.fold(0, (s, l) => s + l.qty * l.price);
  int qtyOf(String itemId) =>
      lines.where((l) => l.itemId == itemId).fold(0, (s, l) => s + l.qty);

  Map<String, dynamic> toJson() => {
        'slug': slug,
        'restaurantName': restaurantName,
        'lines': [for (final l in lines) l.toJson()],
      };

  factory CartState.fromJson(Map<String, dynamic> j) => CartState(
        slug: j['slug'] as String?,
        restaurantName: j['restaurantName'] as String?,
        lines: [
          for (final l in (j['lines'] as List? ?? const []))
            CartLine.fromJson(Map<String, dynamic>.from(l as Map)),
        ],
      );
}

/// Max quantity per line, matching the server's 1..50 bound.
const maxQty = 50;

class CartNotifier extends Notifier<CartState> {
  static const _key = 'deligro-cart';

  @override
  CartState build() {
    final raw = ref.read(prefsProvider).getString(_key);
    if (raw == null) return const CartState();
    try {
      return CartState.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return const CartState();
    }
  }

  void _set(CartState next) {
    state = next.lines.isEmpty ? const CartState() : next;
    ref.read(prefsProvider).setString(_key, jsonEncode(state.toJson()));
  }

  /// True when adding from [r] would replace another shop's basket — the
  /// caller confirms, then calls [add] with `replace: true`.
  bool conflictsWith(Restaurant r) =>
      !state.isEmpty && state.slug != null && state.slug != r.slug;

  void add(Restaurant r, MenuItem item, {bool replace = false}) {
    final base = replace || conflictsWith(r)
        ? CartState(slug: r.slug, restaurantName: r.name)
        : CartState(slug: r.slug, restaurantName: r.name, lines: state.lines);
    final existing = base.lines.indexWhere((l) => l.itemId == item.id);
    final lines = [...base.lines];
    if (existing >= 0) {
      final l = lines[existing];
      lines[existing] = l.copyWith(qty: (l.qty + 1).clamp(1, maxQty));
    } else {
      lines.add(CartLine(
        itemId: item.id,
        name: item.name,
        price: item.effective,
        qty: 1,
        veg: item.veg,
      ));
    }
    _set(CartState(slug: base.slug, restaurantName: base.restaurantName, lines: lines));
  }

  void increment(String itemId) => _update(itemId, 1);
  void decrement(String itemId) => _update(itemId, -1);

  void _update(String itemId, int delta) {
    final lines = <CartLine>[];
    for (final l in state.lines) {
      if (l.itemId != itemId) {
        lines.add(l);
        continue;
      }
      final q = (l.qty + delta).clamp(0, maxQty);
      if (q > 0) lines.add(l.copyWith(qty: q));
    }
    _set(CartState(slug: state.slug, restaurantName: state.restaurantName, lines: lines));
  }

  void remove(String itemId) {
    _set(CartState(
      slug: state.slug,
      restaurantName: state.restaurantName,
      lines: state.lines.where((l) => l.itemId != itemId).toList(),
    ));
  }

  void clear() => _set(const CartState());

  /// Refills the basket from a past order at today's prices, dropping dishes
  /// that are gone or sold out. Returns how many lines were dropped.
  int reorder(Order order, Map<String, ({int price, bool available})> live) {
    var dropped = 0;
    final lines = <CartLine>[];
    for (final l in order.lines) {
      final now = live[l.itemId];
      if (l.itemId.isEmpty || now == null || !now.available) {
        dropped++;
        continue;
      }
      lines.add(CartLine(
        itemId: l.itemId,
        name: l.name,
        price: now.price,
        qty: l.qty.clamp(1, maxQty),
        veg: l.veg,
      ));
    }
    _set(CartState(
      slug: order.restaurantSlug,
      restaurantName: order.restaurantName,
      lines: lines,
    ));
    return dropped;
  }
}

final cartProvider = NotifierProvider<CartNotifier, CartState>(CartNotifier.new);
