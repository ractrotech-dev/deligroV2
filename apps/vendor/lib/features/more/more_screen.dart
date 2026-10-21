import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/i18n.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';

/// One entry in More: a route under `/more` and its label in both languages.
class MoreEntry {
  const MoreEntry(this.path, this.icon, this.en, this.hi);
  final String path;
  final IconData icon;
  final String en;
  final String hi;
}

/// Everything that isn't one of the four main tabs, in the order the client's
/// requirements list them.
const moreEntries = [
  MoreEntry('/more/store', Icons.storefront_outlined, 'Store', 'दुकान'),
  MoreEntry('/more/products', Icons.inventory_2_outlined, 'Products & inventory', 'प्रोडक्ट और स्टॉक'),
  MoreEntry('/more/offers', Icons.local_offer_outlined, 'Offers', 'ऑफ़र'),
  MoreEntry('/more/marketing', Icons.campaign_outlined, 'Marketing requests', 'मार्केटिंग अनुरोध'),
  MoreEntry('/more/reviews', Icons.reviews_outlined, 'Customer reviews', 'ग्राहक समीक्षाएँ'),
  MoreEntry('/more/invoices', Icons.description_outlined, 'Invoices & receipts', 'इनवॉइस और रसीद'),
  MoreEntry('/more/support', Icons.support_agent_outlined, 'Help & support', 'मदद और सपोर्ट'),
  MoreEntry('/more/notifications', Icons.notifications_none_rounded, 'Notifications', 'सूचनाएँ'),
  MoreEntry('/more/settings', Icons.settings_outlined, 'Settings', 'सेटिंग्स'),
];

class MoreScreen extends ConsumerWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final me = ref.watch(vendorMeProvider).value;
    return Scaffold(
      appBar: AppBar(title: Text(tr(ref, 'More', 'और'))),
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
                        Text(me.activeShop.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
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
              title: Text(tr(ref, e.en, e.hi), style: const TextStyle(fontWeight: FontWeight.w600)),
              trailing: Icon(Icons.chevron_right_rounded, color: c.muted),
              minTileHeight: 56,
              onTap: () => context.push(e.path),
            ),
        ],
      ),
    );
  }
}
