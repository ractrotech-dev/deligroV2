import 'dart:convert';

import 'package:deligro_customer/core/options.dart';
import 'package:deligro_customer/models/restaurant.dart';
import 'package:deligro_customer/state/cart.dart';
import 'package:flutter_test/flutter_test.dart';

import 'cart_test.dart' show container, shop;

/// The same dish the website's scripts/qa/order-options.ts uses, so both
/// clients are held to the same answers.
MenuItem biryani() => MenuItem.fromRow({
      'id': 'b1',
      'name': 'Chicken Biryani',
      'price': 260,
      'discount_price': 240,
      'veg': false,
      'available': true,
      'menu_item_variants': [
        {'id': 'full', 'name': 'Full', 'price': 260, 'available': true, 'sort_order': 1},
        {'id': 'half', 'name': 'Half', 'price': 160, 'available': true, 'sort_order': 0},
        {'id': 'family', 'name': 'Family', 'price': 480, 'available': false, 'sort_order': 2},
      ],
      'menu_item_addon_groups': [
        {
          'id': 'g1', 'name': 'Raita', 'min_select': 1, 'max_select': 1, 'sort_order': 0,
          'menu_item_addons': [
            {'id': 'r1', 'name': 'Boondi raita', 'price': 30, 'available': true, 'sort_order': 0},
            {'id': 'r2', 'name': 'Mint raita', 'price': 30, 'available': true, 'sort_order': 1},
          ],
        },
        {
          'id': 'g2', 'name': 'Extras', 'min_select': 0, 'max_select': 2, 'sort_order': 1,
          'menu_item_addons': [
            {'id': 'e1', 'name': 'Egg', 'price': 20, 'available': true, 'sort_order': 0},
            {'id': 'e2', 'name': 'Salan', 'price': 15, 'available': true, 'sort_order': 1},
            {'id': 'e3', 'name': 'Gone', 'price': 5, 'available': false, 'sort_order': 2},
          ],
        },
      ],
      'available_from': '07:00:00',
      'available_to': '11:00:00',
    });

void main() {
  test('reads embedded sizes and add-ons in sort order', () {
    final b = biryani();
    expect(b.variants.map((v) => v.name), ['Half', 'Full', 'Family']);
    expect(b.addonGroups.first.addons.map((a) => a.id), ['r1', 'r2']);
    expect(b.fromPrice, 160);
    expect(b.availableFrom, '07:00');
  });

  test('choice rules match the order-line guard', () {
    final b = biryani();
    expect(choiceProblem(b, OptionChoice.none), isA<ChooseSize>());
    expect(choiceProblem(b, const OptionChoice(variantId: 'family', addonIds: ['r1'])), isA<InvalidChoice>());
    expect(choiceProblem(b, const OptionChoice(variantId: 'half')), isA<GroupMin>());
    expect(choiceProblem(b, const OptionChoice(variantId: 'half', addonIds: ['r1', 'r2'])), isA<GroupMax>());
    expect(choiceProblem(b, const OptionChoice(variantId: 'half', addonIds: ['r1', 'e3'])), isA<InvalidChoice>());
    expect(choiceProblem(b, const OptionChoice(variantId: 'full', addonIds: ['r2', 'e1', 'e2'])), isNull);
  });

  test('price and label', () {
    final b = biryani();
    const c = OptionChoice(variantId: 'full', addonIds: ['r2', 'e1']);
    expect(choicePrice(b, c), 310);
    expect(choiceLabel(b, const OptionChoice(variantId: 'half', addonIds: ['r1', 'e2'])), 'Half · Boondi raita, Salan');
    expect(lineKey('d1', const OptionChoice(variantId: 'h', addonIds: ['b', 'a'])),
        lineKey('d1', const OptionChoice(variantId: 'h', addonIds: ['a', 'b'])));
    expect(lineKey('d1'), 'd1');
  });

  test('offered now, in IST', () {
    final wed0930 = DateTime.utc(2026, 10, 21, 4, 0); // Wednesday 09:30 IST
    expect(offeredNow(from: '07:00', to: '11:00', at: wed0930), isTrue);
    expect(offeredNow(from: '12:00', to: '15:00', at: wed0930), isFalse);
    expect(offeredNow(from: '22:00', to: '02:00', at: DateTime.utc(2026, 10, 20, 19, 30)), isTrue);
    expect(offeredNow(days: [0, 6], at: wed0930), isFalse);
    expect(offeredNow(days: [3], at: wed0930), isTrue);
    expect(offeredNow(days: [4], at: DateTime.utc(2026, 10, 21, 19, 0)), isTrue, reason: 'Thursday 00:30 IST');
  });

  test('closed messages and add-on snapshots', () {
    expect(closedMessage('outside_hours', '10:00'), 'This shop is closed right now. It opens at 10:00 AM.');
    expect(closedMessage('holiday', null), 'This shop is closed today for a holiday.');
    expect(chosenAddons({'variant': null, 'addons': [{'name': 'Egg'}, {'name': 'Salan'}]}), ['Egg', 'Salan']);
    expect(chosenAddons(null), isEmpty);
  });

  test('the basket keeps one line per choice and sends the choice', () async {
    final c = await container();
    final cart = c.read(cartProvider.notifier);
    final b = biryani();
    cart.add(shop('a'), b, choice: const OptionChoice(variantId: 'half', addonIds: ['r1']), qty: 2);
    cart.add(shop('a'), b, choice: const OptionChoice(variantId: 'full', addonIds: ['r2']));
    final s = c.read(cartProvider);
    expect(s.lines.length, 2);
    expect(s.qtyOf('b1'), 3);
    expect(s.lines.first.price, 190);
    expect(s.lines.first.options, 'Half · Boondi raita');
    expect(s.subtotal, 2 * 190 + 290);

    cart.decrement(s.lines.first.key);
    expect(c.read(cartProvider).lines.first.qty, 1);

    final saved = CartState.fromJson(jsonDecode(jsonEncode(c.read(cartProvider).toJson())) as Map<String, dynamic>);
    expect(saved.lines.first.variantId, 'half');
    expect(saved.lines.first.addonIds, ['r1']);
  });

  test('a basket saved before options still loads', () {
    final old = CartState.fromJson({
      'slug': 'a',
      'lines': [
        {'itemId': 'x', 'name': 'X', 'price': 100, 'qty': 1, 'veg': true},
      ],
    });
    expect(old.lines.single.key, 'x');
    expect(old.lines.single.options, '');
  });
}
