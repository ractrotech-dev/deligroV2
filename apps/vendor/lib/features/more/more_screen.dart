import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../state/session.dart';
import '../../theme/app_theme.dart';

/// One entry in More: a route under `/more` and its label.
class MoreEntry {
  const MoreEntry(this.path, this.icon, this.label);
  final String path;
  final IconData icon;
  final String label;
}

/// Everything that isn't one of the four main tabs, in the order the client's
/// requirements list them.
const moreEntries = [
  MoreEntry('/more/store', Icons.storefront_outlined, 'Store'),
  MoreEntry('/more/products', Icons.inventory_2_outlined, 'Products & inventory'),
  MoreEntry('/more/offers', Icons.local_offer_outlined, 'Offers'),
  MoreEntry('/more/marketing', Icons.campaign_outlined, 'Marketing requests'),
  MoreEntry('/more/reviews', Icons.reviews_outlined, 'Customer reviews'),
  MoreEntry('/more/invoices', Icons.description_outlined, 'Invoices & receipts'),
  MoreEntry('/more/support', Icons.support_agent_outlined, 'Help & support'),
  MoreEntry('/more/notifications', Icons.notifications_none_rounded, 'Notifications'),
  MoreEntry('/more/settings', Icons.settings_outlined, 'Settings'),
];

class MoreScreen extends ConsumerWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final me = ref.watch(vendorMeProvider).value;
    return Scaffold(
      appBar: AppBar(title: Text('More')),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 24),
        children: [
          if (me != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 24,
                    backgroundColor: c.accentSoft,
                    child: Icon(Icons.storefront_rounded, color: c.accentInk),
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          me.activeShop.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800),
                        ),
                        if (me.fullName.isNotEmpty || me.phone.isNotEmpty)
                          Text(
                            [me.fullName, me.phone].where((s) => s.isNotEmpty).join(' · '),
                            style: TextStyle(color: c.muted, fontSize: 13),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          for (final e in moreEntries)
            ListTile(
              leading: Icon(e.icon, color: c.ink),
              title: Text(e.label, style: const TextStyle(fontWeight: FontWeight.w600)),
              trailing: Icon(Icons.chevron_right_rounded, color: c.muted),
              minTileHeight: 56,
              onTap: () => context.push(e.path),
            ),
        ],
      ),
    );
  }
}
