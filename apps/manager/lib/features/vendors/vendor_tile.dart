import 'package:flutter/material.dart';

import '../../core/format.dart';
import '../../models/vendors.dart';
import '../../theme/app_theme.dart';
import '../orders/order_labels.dart' show StatusText;

Color vendorStatusColor(AppColors c, VendorStatus s) => switch (s) {
      VendorStatus.active => c.green,
      VendorStatus.pending => c.amberText,
      VendorStatus.suspended || VendorStatus.rejected => c.deal,
      VendorStatus.inactive || VendorStatus.unknown => c.muted,
    };

Color openStateColor(AppColors c, OpenState s) => switch (s) {
      OpenState.open => c.green,
      OpenState.temporarilyClosed || OpenState.holiday => c.amberText,
      _ => c.muted,
    };

/// A shop's logo, or its initials on a soft tile.
class VendorAvatar extends StatelessWidget {
  const VendorAvatar({super.key, required this.name, this.url, this.size = 44});
  final String name;
  final String? url;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final initials = name.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).take(2).map((w) => w[0].toUpperCase()).join();
    final fallback = Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(radiusBlock - 4)),
      child: Text(initials, style: TextStyle(fontWeight: FontWeight.w800, color: c.accentInk, fontSize: size * 0.34)),
    );
    if (url == null || url!.isEmpty) return fallback;
    return ClipRRect(
      borderRadius: BorderRadius.circular(radiusBlock - 4),
      child: Image.network(url!, width: size, height: size, fit: BoxFit.cover, errorBuilder: (_, _, _) => fallback),
    );
  }
}

/// Stars as an icon and a figure (the ★ glyph is missing from some fonts).
class RatingText extends StatelessWidget {
  const RatingText({super.key, required this.rating, this.count, this.size = 13});
  final double? rating;
  final int? count;
  final double size;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    if (rating == null) return Text('No ratings yet', style: TextStyle(color: c.muted, fontSize: size));
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.star_rounded, size: size + 3, color: c.pop),
        const SizedBox(width: 2),
        Text(rating!.toStringAsFixed(1), style: dataStyle(context, size: size, weight: FontWeight.w700)),
        if (count != null)
          Flexible(
            child: Text(' (${countWords(count!)})',
                maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: c.muted, fontSize: size - 0.5)),
          ),
      ],
    );
  }
}

String countWords(int n) => count(n);

/// A small counted reason to look ("2 documents", "1 complaint").
class CountBadge extends StatelessWidget {
  const CountBadge({super.key, required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(999)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 13, color: c.deal),
          const SizedBox(width: 4),
          Flexible(
            child: Text(text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c.deal)),
          ),
        ],
      ),
    );
  }
}

class VendorTile extends StatelessWidget {
  const VendorTile({super.key, required this.vendor, required this.onTap, this.selected = false});
  final VendorListItem vendor;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final v = vendor;
    return Material(
      color: selected ? c.accentSoft : c.surface,
      borderRadius: BorderRadius.circular(radiusBlock),
      child: InkWell(
        key: Key('vendor-tile-${v.id}'),
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
              VendorAvatar(name: v.name, url: v.logoUrl),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(v.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: c.ink)),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 12,
                      runSpacing: 4,
                      children: [
                        StatusText(v.status.label, color: vendorStatusColor(c, v.status)),
                        if (v.status == VendorStatus.active || v.status == VendorStatus.inactive)
                          StatusText(v.openState.label, color: openStateColor(c, v.openState)),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Expanded(
                          child: Align(
                            alignment: Alignment.centerLeft,
                            child: RatingText(rating: v.rating, count: v.rating == null ? null : v.ratingCount, size: 12.5),
                          ),
                        ),
                        Text('${v.todayOrders}', style: dataStyle(context, size: 13.5, weight: FontWeight.w700)),
                        Text(' today', style: TextStyle(fontSize: 12.5, color: c.muted)),
                      ],
                    ),
                    if (v.pendingDocuments > 0 || v.openComplaints > 0) ...[
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          if (v.pendingDocuments > 0)
                            CountBadge(
                              icon: Icons.description_outlined,
                              text: '${v.pendingDocuments} document${v.pendingDocuments == 1 ? '' : 's'} to review',
                            ),
                          if (v.openComplaints > 0)
                            CountBadge(
                              icon: Icons.report_outlined,
                              text: '${v.openComplaints} complaint${v.openComplaints == 1 ? '' : 's'}',
                            ),
                        ],
                      ),
                    ],
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

class VendorTileSkeleton extends StatelessWidget {
  const VendorTileSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget bar(double w) => Container(
          width: w,
          height: 11,
          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(6)),
        );
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock - 4)),
          ),
          const SizedBox(width: 12),
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [bar(150), const SizedBox(height: 8), bar(90)]),
        ],
      ),
    );
  }
}
