import 'package:flutter/material.dart';

import '../../core/format.dart';
import '../../models/products.dart';
import '../../theme/app_theme.dart';
import '../orders/order_labels.dart' show StatusText;

/// "₹180", "₹210 (was ₹240)" or, with a parked change, "₹180 → ₹220 pending".
String priceWords(ProductListItem p) {
  if (p.pendingPrice != null) return '${rupees(p.price)} → ${rupees(p.pendingPrice!)} pending';
  if (p.discountPrice != null && p.discountPrice! < p.price) return '${rupees(p.discountPrice!)} (was ${rupees(p.price)})';
  return rupees(p.price);
}

/// Available / Unavailable / Sold out, as a dot and a word.
(String, Color) availabilityWords(AppColors c, ProductListItem p) {
  if (p.hidden) return ('Hidden', c.deal);
  if (p.outOfStock) return ('Sold out', c.deal);
  if (!p.available) return ('Unavailable', c.amberText);
  if (p.lowStock) return ('Low stock', c.amberText);
  return ('Available', c.green);
}

/// A small square image, or a food icon on a soft tile.
class ProductThumb extends StatelessWidget {
  const ProductThumb({super.key, this.url, this.size = 52, this.veg});
  final String? url;
  final double size;
  final bool? veg;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final fallback = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(10)),
      child: Icon(Icons.restaurant_menu, color: c.muted, size: size * 0.42),
    );
    final img = url == null || url!.isEmpty
        ? fallback
        : ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: Image.network(url!, width: size, height: size, fit: BoxFit.cover, errorBuilder: (_, _, _) => fallback),
          );
    if (veg == null) return img;
    return Stack(
      children: [
        img,
        Positioned(
          left: 4,
          top: 4,
          child: Container(
            width: 12,
            height: 12,
            decoration: BoxDecoration(
              color: c.surface,
              border: Border.all(color: veg! ? c.green : c.deal, width: 1.5),
              borderRadius: BorderRadius.circular(2),
            ),
            child: Center(
              child: Container(width: 5, height: 5, decoration: BoxDecoration(color: veg! ? c.green : c.deal, shape: BoxShape.circle)),
            ),
          ),
        ),
      ],
    );
  }
}

/// A tag for a state that needs a look (pending approval, flagged, hidden).
class Tag extends StatelessWidget {
  const Tag(this.text, {super.key, required this.color, required this.bg});
  final String text;
  final Color color;
  final Color bg;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
        child: Text(text, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: color)),
      );
}

class ProductTile extends StatelessWidget {
  const ProductTile({super.key, required this.product, required this.onTap, this.selected = false});
  final ProductListItem product;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final p = product;
    final (avail, availColor) = availabilityWords(c, p);
    return Material(
      color: selected ? c.accentSoft : c.surface,
      borderRadius: BorderRadius.circular(radiusBlock),
      child: InkWell(
        key: Key('product-tile-${p.id}'),
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(radiusBlock),
            border: Border.all(color: selected ? c.accent : c.line),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ProductThumb(url: p.imageUrl, veg: p.veg),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: c.ink)),
                    const SizedBox(height: 2),
                    Text([p.vendor.name, ?p.category].join(' · '),
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: c.muted, fontSize: 12.5)),
                    const SizedBox(height: 6),
                    Text(priceWords(p), style: dataStyle(context, size: 13.5, weight: FontWeight.w700)),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 10,
                      runSpacing: 6,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        StatusText(avail, color: availColor),
                        if (!p.outOfStock) Text(p.stockWords, style: TextStyle(color: c.muted, fontSize: 12.5)),
                        if (p.approvalStatus == ApprovalStatus.pending) Tag('Waiting for approval', color: c.amberText, bg: c.pop.withValues(alpha: 0.16)),
                        if (p.approvalStatus == ApprovalStatus.rejected) Tag('Rejected', color: c.deal, bg: c.dealSoft),
                        if (p.openFlags > 0) Tag('${p.openFlags} flag${p.openFlags == 1 ? '' : 's'}', color: c.deal, bg: c.dealSoft),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
