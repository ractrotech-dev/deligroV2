import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/options.dart';
import '../../models/restaurant.dart';
import '../../state/cart.dart';
import '../../theme/app_theme.dart';
import '../../widgets/cart_widgets.dart';
import '../../widgets/common.dart';

/// The dish up close: big photo, full description, pick a size and add-ons
/// (0062) and a quantity, add. Add stays off until the choice is one the
/// order-line guard would accept.
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

  // The first size on offer is picked to start with, as menus print it.
  late OptionChoice _choice = OptionChoice(
    variantId: widget.item.variants.where((v) => v.available).firstOrNull?.id,
  );

  int _inBasket() {
    final cart = ref.read(cartProvider);
    return cart.slug == widget.restaurant.slug ? cart.qtyOf(widget.item.id) : 0;
  }

  Future<void> _add() async {
    setState(() => _busy = true);
    final before = _inBasket();
    // May ask to replace another shop's basket; close only once it landed.
    await addToCart(context, ref, widget.restaurant, widget.item, choice: _choice, qty: _qty);
    if (!mounted) return;
    if (_inBasket() > before) {
      Navigator.pop(context);
    } else {
      setState(() => _busy = false);
    }
  }

  void _toggleAddon(MenuAddonGroup g, String id) {
    final inGroup = {for (final a in g.addons) a.id};
    final picked = _choice.addonIds.where(inGroup.contains).toList();
    var next = [..._choice.addonIds];
    if (picked.contains(id)) {
      next.remove(id);
    } else if (g.maxSelect == 1) {
      next = [...next.where((a) => !inGroup.contains(a)), id];
    } else if (picked.length < g.maxSelect) {
      next.add(id);
    }
    setState(() => _choice = OptionChoice(variantId: _choice.variantId, addonIds: next));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = widget.restaurant;
    final item = widget.item;
    final offered = item.offered;
    final problem = choiceProblem(item, _choice);
    final maxHere = item.stockLeft == null ? maxQty : item.stockLeft!.clamp(1, maxQty);
    final canAdd = r.open && item.available && offered && problem == null;
    final inBasket = ref.watch(cartProvider.select(
      (s) => s.slug == r.slug ? s.qtyOf(item.id) : 0,
    ));

    final String commit;
    if (!r.open) {
      commit = 'Closed';
    } else if (!item.available) {
      commit = 'Sold out';
    } else if (!offered) {
      commit = 'Not available now';
    } else {
      commit = 'Add item · ${rupees(choicePrice(item, _choice) * _qty)}';
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
                        if (item.variants.isEmpty)
                          PriceText(price: item.price, effective: item.effective, size: 17)
                        else
                          Text('from ${rupees(item.fromPrice)}',
                              style: dataStyle(context, size: 17, weight: FontWeight.w800)),
                        _Availability(item: item, offered: offered),
                        if (item.description.trim().isNotEmpty) ...[
                          const SizedBox(height: 12),
                          Text(
                            item.description.trim(),
                            style: TextStyle(color: c.muted, fontSize: 14.5, height: 1.45),
                          ),
                        ],
                        if (hasOptions(item)) ...[
                          const SizedBox(height: 6),
                          _OptionsPicker(
                            item: item,
                            choice: _choice,
                            onSize: (id) => setState(() => _choice = OptionChoice(variantId: id, addonIds: _choice.addonIds)),
                            onAddon: _toggleAddon,
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
                    onPlus: _qty < maxHere ? () => setState(() => _qty++) : null,
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

/// When the dish is offered, and how many are left when that matters.
class _Availability extends StatelessWidget {
  const _Availability({required this.item, required this.offered});
  final MenuItem item;
  final bool offered;

  static const _days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final notes = <String>[
      if (item.availableFrom != null && item.availableTo != null)
        'Available ${clockLabel(item.availableFrom)} – ${clockLabel(item.availableTo)}',
      if (item.availableDays != null && item.availableDays!.isNotEmpty && item.availableDays!.length < 7)
        item.availableDays!.map((d) => _days[d]).join(', '),
    ];
    final low = item.stockLeft != null && item.stockLeft! > 0 && item.stockLeft! <= 5;
    if (notes.isEmpty && !low) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        children: [
          if (notes.isNotEmpty)
            _Tag(
              label: offered ? notes.join(' · ') : 'Not available now · ${notes.join(' · ')}',
              color: offered ? c.ink : c.deal,
              background: offered ? c.surface2 : c.dealSoft,
            ),
          if (low) _Tag(label: 'Only ${item.stockLeft} left', color: c.deal, background: c.dealSoft),
        ],
      ),
    );
  }
}

/// Sizes as radio rows; each add-on group as checkboxes within its min/max.
class _OptionsPicker extends StatelessWidget {
  const _OptionsPicker({required this.item, required this.choice, required this.onSize, required this.onAddon});
  final MenuItem item;
  final OptionChoice choice;
  final ValueChanged<String> onSize;
  final void Function(MenuAddonGroup group, String addonId) onAddon;

  String _rule(MenuAddonGroup g) {
    if (g.minSelect == 0) return 'Optional · up to ${g.maxSelect}';
    if (g.minSelect == g.maxSelect) return 'Required · pick ${g.minSelect}';
    return 'Required · pick ${g.minSelect}–${g.maxSelect}';
  }

  Widget _heading(BuildContext context, String title, String rule) => Padding(
        padding: const EdgeInsets.only(top: 14, bottom: 4),
        child: Row(
          children: [
            Text(title, style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w800)),
            const SizedBox(width: 8),
            Text(rule, style: TextStyle(color: context.colors.muted, fontSize: 12.5, fontWeight: FontWeight.w600)),
          ],
        ),
      );

  Widget _row(BuildContext context, {
    required bool on,
    required bool round,
    required String name,
    required String price,
    required VoidCallback? onTap,
  }) {
    final c = context.colors;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Opacity(
        opacity: onTap == null ? .45 : 1,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Row(
            children: [
              Icon(
                round
                    ? (on ? Icons.radio_button_checked_rounded : Icons.radio_button_off_rounded)
                    : (on ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded),
                color: on ? c.accent : c.muted,
              ),
              const SizedBox(width: 12),
              Expanded(child: Text(name, style: const TextStyle(fontSize: 15))),
              Text(price, style: dataStyle(context, size: 14.5, weight: FontWeight.w700)),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (item.variants.isNotEmpty) ...[
          _heading(context, 'Choose a size', 'Required'),
          for (final v in item.variants)
            Semantics(
              inMutuallyExclusiveGroup: true,
              checked: choice.variantId == v.id,
              child: _row(
                context,
                on: choice.variantId == v.id,
                round: true,
                name: v.name,
                price: v.available ? rupees(v.price) : 'Sold out',
                onTap: v.available ? () => onSize(v.id) : null,
              ),
            ),
        ],
        for (final g in item.addonGroups) ...[
          _heading(context, g.name, _rule(g)),
          for (final a in g.addons)
            () {
              final on = choice.addonIds.contains(a.id);
              final picked = g.addons.where((x) => choice.addonIds.contains(x.id)).length;
              final full = !on && g.maxSelect > 1 && picked >= g.maxSelect;
              return Semantics(
                checked: on,
                child: _row(
                  context,
                  on: on,
                  round: g.maxSelect == 1,
                  name: a.name,
                  price: !a.available ? 'Sold out' : (a.price > 0 ? '+${rupees(a.price)}' : 'Free'),
                  onTap: a.available && !full ? () => onAddon(g, a.id) : null,
                ),
              );
            }(),
        ],
      ],
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
