import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/format.dart';
import '../core/options.dart';
import '../core/pricing.dart';
import '../models/restaurant.dart';
import '../models/settings.dart';
import '../state/cart.dart';
import '../state/providers.dart';
import '../theme/app_theme.dart';
import 'common.dart';

/// Adds [item] (with [choice], [qty] of it) to the basket, asking first when
/// the basket holds another shop's food (CartSwitchDialog on the web).
Future<void> addToCart(
  BuildContext context,
  WidgetRef ref,
  Restaurant r,
  MenuItem item, {
  OptionChoice choice = OptionChoice.none,
  int qty = 1,
}) async {
  final cart = ref.read(cartProvider.notifier);
  if (!cart.conflictsWith(r)) {
    cart.add(r, item, choice: choice, qty: qty);
    return;
  }
  final other = ref.read(cartProvider).restaurantName ?? 'another restaurant';
  final replace = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Start a new basket?'),
      content: Text('Your basket has items from $other. Adding this will clear them.'),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep basket')),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Start new')),
      ],
    ),
  );
  if (replace == true) cart.add(r, item, replace: true, choice: choice, qty: qty);
}

/// The add control on a menu or search row: Closed, Not now (outside the
/// dish's hours), or a stepper. A dish with sizes or add-ons is chosen in
/// its item sheet ([onChoose]); its minus takes one off when it's in the
/// basket one way only, and opens the basket otherwise.
class MenuAddControl extends ConsumerWidget {
  const MenuAddControl({super.key, required this.restaurant, required this.item, required this.onChoose});
  final Restaurant restaurant;
  final MenuItem item;
  final VoidCallback onChoose;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final r = restaurant;
    final lines = ref.watch(cartProvider.select(
      (s) => s.slug == r.slug ? s.lines.where((l) => l.itemId == item.id).toList() : const <CartLine>[],
    ));
    final qty = lines.fold(0, (n, l) => n + l.qty);
    if (!r.open) return const _StatusChip('Closed');
    if (!item.offered) return const _StatusChip('Not now');
    final cart = ref.read(cartProvider.notifier);
    if (hasOptions(item)) {
      return QtyStepper(
        compact: true,
        qty: qty,
        enabled: item.available,
        onAdd: onChoose,
        onRemove: () => lines.length == 1 ? cart.decrement(lines.first.key) : showCartSheet(context),
      );
    }
    return QtyStepper(
      compact: true,
      qty: qty,
      enabled: item.available,
      onAdd: () => addToCart(context, ref, r, item),
      onRemove: () => cart.decrement(item.id),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip(this.label);
  final String label;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      height: 34,
      padding: const EdgeInsets.symmetric(horizontal: 14),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: c.line),
      ),
      child: Text(label, style: TextStyle(color: c.muted, fontWeight: FontWeight.w800, fontSize: 13)),
    );
  }
}

/// A dish's price: "from ₹x" when its sizes set it, else with any sale shown.
class MenuPrice extends StatelessWidget {
  const MenuPrice(this.item, {super.key, this.size = 15});
  final MenuItem item;
  final double size;

  @override
  Widget build(BuildContext context) {
    if (item.variants.isEmpty) return PriceText(price: item.price, effective: item.effective, size: size);
    return Text('from ${rupees(item.fromPrice)}', style: dataStyle(context, size: size, weight: FontWeight.w800));
  }
}

/// Floating "n items · ₹x  View basket" bar. Renders nothing when empty.
class CartBar extends ConsumerWidget {
  const CartBar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cart = ref.watch(cartProvider);
    if (cart.isEmpty) return const SizedBox.shrink();
    final c = context.colors;
    return SafeArea(
      top: false,
      minimum: const EdgeInsets.fromLTRB(12, 0, 12, 10),
      child: Material(
        color: c.accent,
        borderRadius: BorderRadius.circular(16),
        elevation: 6,
        shadowColor: c.accent.withValues(alpha: .4),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () => showCartSheet(context),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              children: [
                Icon(Icons.shopping_basket_rounded, color: c.onAccent),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        '${cart.count} ${cart.count == 1 ? 'item' : 'items'} · ${rupees(cart.subtotal)}',
                        style: TextStyle(color: c.onAccent, fontWeight: FontWeight.w800, fontSize: 15),
                      ),
                      if (cart.restaurantName != null)
                        Text(
                          cart.restaurantName!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: c.onAccent.withValues(alpha: .8), fontSize: 12),
                        ),
                    ],
                  ),
                ),
                Text('View basket', style: TextStyle(color: c.onAccent, fontWeight: FontWeight.w800)),
                Icon(Icons.chevron_right_rounded, color: c.onAccent),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

Future<void> showCartSheet(BuildContext context) => showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => const _CartSheet(),
    );

class _CartSheet extends ConsumerWidget {
  const _CartSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final cart = ref.watch(cartProvider);
    final notifier = ref.read(cartProvider.notifier);
    final settings = ref.watch(settingsProvider).value ?? PlatformSettings.defaults;
    final charges = computeCharges(settings.charges, cart.subtotal);
    final c = context.colors;

    if (cart.isEmpty) {
      return const SizedBox(
        height: 260,
        child: EmptyState(icon: Icons.shopping_basket_outlined, title: 'Your basket is empty'),
      );
    }

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: .7,
      maxChildSize: .92,
      minChildSize: .4,
      builder: (context, scroll) => Column(
        children: [
          Expanded(
            child: ListView(
              controller: scroll,
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text('Your basket', style: Theme.of(context).textTheme.titleLarge),
                    ),
                    TextButton(
                      onPressed: () {
                        Navigator.pop(context);
                        context.push('/restaurant/${cart.slug}');
                      },
                      child: Text(cart.restaurantName ?? 'Menu'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                for (final l in cart.lines)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Row(
                      children: [
                        VegMark(l.veg),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(l.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                              if (l.options.isNotEmpty)
                                Text(l.options, style: TextStyle(color: c.muted, fontSize: 12.5)),
                              Text(rupees(l.price), style: TextStyle(color: c.muted, fontSize: 13)),
                            ],
                          ),
                        ),
                        QtyStepper(
                          compact: true,
                          qty: l.qty,
                          onAdd: () => notifier.increment(l.key),
                          onRemove: () => notifier.decrement(l.key),
                        ),
                        SizedBox(
                          width: 70,
                          child: Text(rupees(l.price * l.qty),
                              textAlign: TextAlign.right, style: dataStyle(context)),
                        ),
                      ],
                    ),
                  ),
                const Divider(height: 28),
                BillRow('Subtotal', rupees(charges.subtotal)),
                BillRow(
                  'Delivery',
                  charges.deliveryFee == 0 ? 'Free' : rupees(charges.deliveryFee),
                  highlight: charges.deliveryFee == 0,
                ),
                BillRow('Taxes', rupees(charges.taxes)),
                if (settings.charges.freeDeliveryThreshold > 0 && charges.deliveryFee > 0)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      'Add ${rupees(settings.charges.freeDeliveryThreshold - cart.subtotal)} more for free delivery',
                      style: TextStyle(color: c.green, fontWeight: FontWeight.w700, fontSize: 13),
                    ),
                  ),
                const Divider(height: 24),
                BillRow('Total', rupees(charges.total), bold: true),
              ],
            ),
          ),
          SafeArea(
            top: false,
            minimum: const EdgeInsets.fromLTRB(16, 4, 16, 12),
            child: SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () {
                  Navigator.pop(context);
                  context.push('/checkout');
                },
                child: Text('Checkout · ${rupees(charges.total)}'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class BillRow extends StatelessWidget {
  const BillRow(this.label, this.value, {super.key, this.bold = false, this.highlight = false, this.negative = false});
  final String label;
  final String value;
  final bool bold;
  final bool highlight;
  final bool negative;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final color = highlight || negative ? c.green : (bold ? c.ink : c.muted);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Expanded(
            child: Text(label,
                style: TextStyle(
                  color: bold ? c.ink : c.muted,
                  fontWeight: bold ? FontWeight.w800 : FontWeight.w500,
                  fontSize: bold ? 16 : 14,
                )),
          ),
          Text(negative ? '−$value' : value,
              style: dataStyle(context, size: bold ? 16 : 14, weight: bold ? FontWeight.w800 : FontWeight.w600)
                  .copyWith(color: color)),
        ],
      ),
    );
  }
}
