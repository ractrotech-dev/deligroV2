import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../models/restaurant.dart';
import '../../state/cart.dart';
import '../../theme/app_theme.dart';
import '../../widgets/cart_widgets.dart';
import '../../widgets/common.dart';

/// The dish up close: big photo, full description, pick a quantity, add.
Future<void> showItemSheet(BuildContext context, Restaurant restaurant, MenuItem item) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: false,
      builder: (_) => _ItemSheet(restaurant: restaurant, item: item),
    );

class _ItemSheet extends ConsumerStatefulWidget {
  const _ItemSheet({required this.restaurant, required this.item});
  final Restaurant restaurant;
  final MenuItem item;

  @override
  ConsumerState<_ItemSheet> createState() => _ItemSheetState();
}

class _ItemSheetState extends ConsumerState<_ItemSheet> {
  int _qty = 1;
  bool _busy = false;

  int _inBasket() {
    final cart = ref.read(cartProvider);
    return cart.slug == widget.restaurant.slug ? cart.qtyOf(widget.item.id) : 0;
  }

  Future<void> _add() async {
    setState(() => _busy = true);
    final before = _inBasket();
    // The first add may ask to replace another shop's basket; only top up
    // once it actually landed.
    await addToCart(context, ref, widget.restaurant, widget.item);
    if (!mounted) return;
    if (_inBasket() > before) {
      final cart = ref.read(cartProvider.notifier);
      for (var i = 1; i < _qty; i++) {
        cart.increment(widget.item.id);
      }
      Navigator.pop(context);
    } else {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = widget.restaurant;
    final item = widget.item;
    final canAdd = r.open && item.available;
    final inBasket = ref.watch(cartProvider.select(
      (s) => s.slug == r.slug ? s.qtyOf(item.id) : 0,
    ));

    final String commit;
    if (!r.open) {
      commit = 'Closed';
    } else if (!item.available) {
      commit = 'Sold out';
    } else {
      commit = 'Add item · ${rupees(item.effective * _qty)}';
    }

    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * .88),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Flexible(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Stack(
                    children: [
                      if (item.image != null)
                        AspectRatio(
                          aspectRatio: 16 / 11,
                          child: ClipRRect(
                            borderRadius: const BorderRadius.vertical(top: Radius.circular(radiusSheet)),
                            child: NetImage(url: item.image, tint: r.accentTint, radius: 0),
                          ),
                        )
                      else
                        const SizedBox(height: 56),
                      Positioned(
                        right: 12,
                        top: 12,
                        child: IconButton(
                          tooltip: 'Close',
                          onPressed: () => Navigator.pop(context),
                          style: IconButton.styleFrom(
                            backgroundColor: c.surface,
                            foregroundColor: c.ink,
                            minimumSize: const Size(44, 44),
                          ),
                          icon: const Icon(Icons.close_rounded),
                        ),
                      ),
                    ],
                  ),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            VegMark(item.veg, size: 16),
                            if (item.popular) ...[
                              const SizedBox(width: 8),
                              _Tag(label: 'Bestseller', color: c.accentInk, background: c.accentSoft),
                            ],
                            if (!item.available) ...[
                              const SizedBox(width: 8),
                              _Tag(label: 'Sold out', color: c.muted, background: c.surface2),
                            ],
                          ],
                        ),
                        const SizedBox(height: 10),
                        Text(
                          item.name,
                          style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontSize: 22),
                        ),
                        const SizedBox(height: 6),
                        PriceText(price: item.price, effective: item.effective, size: 17),
                        if (item.description.trim().isNotEmpty) ...[
                          const SizedBox(height: 12),
                          Text(
                            item.description.trim(),
                            style: TextStyle(color: c.muted, fontSize: 14.5, height: 1.45),
                          ),
                        ],
                        if (inBasket > 0) ...[
                          const SizedBox(height: 12),
                          Text(
                            '$inBasket already in your basket',
                            style: TextStyle(color: c.green, fontWeight: FontWeight.w700, fontSize: 13),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          SafeArea(
            top: false,
            minimum: const EdgeInsets.fromLTRB(20, 8, 20, 14),
            child: Row(
              children: [
                if (canAdd) ...[
                  _LocalStepper(
                    qty: _qty,
                    onMinus: _qty > 1 ? () => setState(() => _qty--) : null,
                    onPlus: _qty < maxQty ? () => setState(() => _qty++) : null,
                  ),
                  const SizedBox(width: 12),
                ],
                Expanded(
                  child: FilledButton(
                    onPressed: canAdd && !_busy ? _add : null,
                    child: Text(commit, maxLines: 1, overflow: TextOverflow.ellipsis),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag({required this.label, required this.color, required this.background});
  final String label;
  final Color color;
  final Color background;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(6)),
        child: Text(label, style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w800)),
      );
}

class _LocalStepper extends StatelessWidget {
  const _LocalStepper({required this.qty, required this.onMinus, required this.onPlus});
  final int qty;
  final VoidCallback? onMinus;
  final VoidCallback? onPlus;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      height: 52,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
        color: c.surface,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            tooltip: 'Remove one',
            onPressed: onMinus,
            color: c.accentInk,
            icon: const Icon(Icons.remove_rounded),
          ),
          SizedBox(
            width: 26,
            child: Text('$qty', textAlign: TextAlign.center, style: dataStyle(context, size: 16, weight: FontWeight.w800)),
          ),
          IconButton(
            tooltip: 'Add one',
            onPressed: onPlus,
            color: c.accentInk,
            icon: const Icon(Icons.add_rounded),
          ),
        ],
      ),
    );
  }
}
