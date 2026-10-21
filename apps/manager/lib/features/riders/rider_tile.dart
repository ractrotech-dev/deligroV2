import 'package:flutter/material.dart';

import '../../models/rider.dart';
import '../../theme/app_theme.dart';
import '../orders/order_labels.dart' show StatusText;
import '../vendors/vendor_tile.dart' show RatingText, VendorAvatar;

/// A fix older than this is shown greyed (design §6.12, same as Live).
const staleFixSeconds = 120;

Color riderStateColor(AppColors c, RiderState s) => switch (s) {
      RiderState.available || RiderState.online => c.green,
      RiderState.onDelivery => c.accent,
      RiderState.onBreak => c.violet,
      RiderState.stale => c.amberText,
      RiderState.offline || RiderState.unknown => c.muted,
    };

Color verificationColor(AppColors c, RiderVerification v) => switch (v) {
      RiderVerification.verified => c.green,
      RiderVerification.pending => c.amberText,
      RiderVerification.rejected => c.deal,
      RiderVerification.unverified || RiderVerification.unknown => c.muted,
    };

Color accountColor(AppColors c, RiderAccount a) => switch (a) {
      RiderAccount.active => c.green,
      RiderAccount.suspended || RiderAccount.restricted => c.deal,
      RiderAccount.unknown => c.muted,
    };

/// "updated just now" / "updated 6 min ago" / "updated 3 h ago" /
/// "no location yet".
String fixAgeText(int? seconds) {
  if (seconds == null) return 'no location yet';
  if (seconds < 60) return 'updated just now';
  if (seconds < 3600) return 'updated ${seconds ~/ 60} min ago';
  if (seconds < 86400) return 'updated ${seconds ~/ 3600} h ago';
  final d = seconds ~/ 86400;
  return 'updated $d ${d == 1 ? 'day' : 'days'} ago';
}

String _plural(int n, String one, String many) => n == 1 ? '1 $one' : '$n $many';

/// One rider in the list: who, their state and last fix, today's count and
/// rating, and the badges that need a manager's eye.
class RiderTile extends StatelessWidget {
  const RiderTile({super.key, required this.rider, this.onTap, this.selected = false});
  final RiderListItem rider;
  final VoidCallback? onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = rider;
    final stale = r.fixAgeSeconds == null || r.fixAgeSeconds! > staleFixSeconds;
    final badges = <(String, Color)>[
      if (r.account != RiderAccount.active && r.account != RiderAccount.unknown) (r.account.label, c.deal),
      if (r.pendingDocuments > 0) (_plural(r.pendingDocuments, 'document to review', 'documents to review'), c.amberText),
      if (r.expiringDocuments > 0) ('${r.expiringDocuments} expiring', c.amberText),
      if (r.openComplaints > 0) (_plural(r.openComplaints, 'open complaint', 'open complaints'), c.deal),
    ];
    return Material(
      color: selected ? c.accentSoft : c.surface,
      borderRadius: BorderRadius.circular(radiusBlock),
      child: InkWell(
        key: Key('rider-tile-${r.id}'),
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
              VendorAvatar(name: r.displayName, url: r.photoUrl, size: 44),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            r.displayName,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink),
                          ),
                        ),
                        if (r.riderCode != null) ...[
                          const SizedBox(width: 8),
                          Text(r.riderCode!, style: dataStyle(context, size: 12, weight: FontWeight.w600)
                              .copyWith(color: c.muted)),
                        ],
                      ],
                    ),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 10,
                      runSpacing: 2,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        StatusText(r.state.label, color: riderStateColor(c, r.state)),
                        Text(
                          fixAgeText(r.fixAgeSeconds),
                          style: TextStyle(fontSize: 12, color: stale ? c.muted : c.ink),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Text('${r.deliveredToday}', style: dataStyle(context, size: 13)),
                        Text(' today', style: TextStyle(fontSize: 12.5, color: c.muted)),
                        const SizedBox(width: 12),
                        RatingText(rating: r.rating, count: r.rating == null ? null : r.ratingCount, size: 12.5),
                      ],
                    ),
                    if (badges.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 10,
                        runSpacing: 4,
                        children: [for (final (t, col) in badges) StatusText(t, color: col, size: 12)],
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

class RiderTileSkeleton extends StatelessWidget {
  const RiderTileSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget bar(double w) => Container(
          width: w,
          height: 11,
          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(6)),
        );
    return Container(
      height: 96,
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
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [bar(140), const SizedBox(height: 8), bar(90), const SizedBox(height: 8), bar(110)],
          ),
        ],
      ),
    );
  }
}
