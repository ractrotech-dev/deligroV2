import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';

/// The active shop's name; for an owner of several shops, a tap opens the
/// list. Picking one sends it to the server as the shop cookie and reloads.
class ShopSwitcher extends ConsumerWidget {
  const ShopSwitcher({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(vendorMeProvider).value;
    if (me == null || me.shops.isEmpty) return const SizedBox.shrink();
    final c = context.colors;
    final shop = me.activeShop;
    final many = me.shops.length > 1;

    final label = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: shop.isOpen ? c.green : c.muted, shape: BoxShape.circle),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            shop.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink),
          ),
        ),
        if (many) Icon(Icons.expand_more_rounded, color: c.muted),
      ],
    );

    if (!many) return Semantics(label: shop.name, child: label);

    return Semantics(
      button: true,
      label: 'Shop: ${shop.name}. Tap to switch shop',
      excludeSemantics: true,
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: () => showModalBottomSheet<void>(
          context: context,
          showDragHandle: true,
          builder: (sheet) => SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                  child: Text('Your shops', style: Theme.of(context).textTheme.titleLarge),
                ),
                for (final s in me.shops)
                  ListTile(
                    leading: Icon(Icons.storefront_rounded, color: s.slug == shop.slug ? c.accent : c.muted),
                    title: Text(s.name, style: const TextStyle(fontWeight: FontWeight.w700)),
                    subtitle: Text(s.isOpen ? 'Open' : 'Closed'),
                    trailing: s.slug == shop.slug ? Icon(Icons.check_rounded, color: c.accent) : null,
                    onTap: () {
                      Navigator.pop(sheet);
                      if (s.slug != shop.slug) ref.read(activeShopSlugProvider.notifier).set(s.slug);
                    },
                  ),
                const SizedBox(height: 8),
              ],
            ),
          ),
        ),
        child: Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: label),
      ),
    );
  }
}
