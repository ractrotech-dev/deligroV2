import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../models/products.dart';
import '../../theme/app_theme.dart';

/// Price, availability, stock and listing changes, newest first (§12.5,
/// §12.6): "Price ₹160 → ₹180 · vendor · 12 Oct 14:20".
class ProductHistory extends StatelessWidget {
  const ProductHistory({super.key, required this.changes});
  final List<ProductChange> changes;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    if (changes.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text('No changes recorded yet.', style: TextStyle(color: c.muted)),
      );
    }
    final when = DateFormat('d MMM HH:mm');
    return Column(
      children: [
        for (final ch in changes)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Icon(_icon(ch.field), size: 16, color: c.muted),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(ch.summary, style: TextStyle(color: c.ink, fontWeight: FontWeight.w600, fontSize: 13.5)),
                      const SizedBox(height: 2),
                      Text(
                        [
                          ch.source.label,
                          if (ch.actor != null && ch.actor!.name.isNotEmpty) ch.actor!.name,
                          if (ch.at != null) when.format(ch.at!.toLocal()),
                        ].join(' · '),
                        style: TextStyle(color: c.muted, fontSize: 12),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  static IconData _icon(String field) => switch (field) {
        'price' || 'discount_price' => Icons.currency_rupee,
        'available' => Icons.toggle_on_outlined,
        'stock_qty' => Icons.inventory_2_outlined,
        'image_url' => Icons.image_outlined,
        'approval_status' => Icons.verified_outlined,
        'hidden_by_ops' => Icons.visibility_off_outlined,
        _ => Icons.edit_outlined,
      };
}
