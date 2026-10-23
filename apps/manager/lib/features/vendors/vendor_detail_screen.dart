import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/secure_screens.dart';
import '../../models/vendors.dart';
import '../../state/vendors.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../orders/order_labels.dart' show StatusText;
import 'vendor_actions.dart';
import 'vendor_tabs.dart';
import 'vendor_tile.dart';

/// One vendor (§4.3–4.15): who they are, their documents, reviews, money and
/// complaints, and the audited decisions this manager may take on them.
class VendorDetailScreen extends ConsumerWidget {
  const VendorDetailScreen({super.key, required this.vendorId});
  final String vendorId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(vendorDetailProvider(vendorId)).value?.name;
    return Scaffold(
      backgroundColor: context.colors.bg,
      appBar: AppBar(title: Text(name ?? 'Vendor'), backgroundColor: context.colors.bg),
      body: VendorDetailBody(vendorId: vendorId),
    );
  }
}

/// The detail without its app bar — also the right-hand pane on a tablet.
class VendorDetailBody extends ConsumerWidget {
  const VendorDetailBody({super.key, required this.vendorId});
  final String vendorId;

  @override
  Widget build(BuildContext context, WidgetRef ref) => KeyedSubtree(
        key: const Key('vendor-detail-body'),
        child: AsyncView(
          value: ref.watch(vendorDetailProvider(vendorId)),
          onRetry: () => ref.invalidate(vendorDetailProvider(vendorId)),
          builder: (v) => _Detail(vendor: v),
        ),
      );
}

class _Detail extends ConsumerWidget {
  const _Detail({required this.vendor});
  final VendorDetail vendor;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tabs = <(String, Widget)>[
      ('Overview', VendorOverviewTab(vendor: vendor)),
      ('Documents', VendorDocumentsTab(vendor: vendor)),
      ('Reviews', VendorReviewsTab(vendorId: vendor.id)),
      if (vendor.finance != null) ('Finance', SecureScope(child: VendorFinanceTab(finance: vendor.finance!))),
      ('Complaints', VendorComplaintsTab(vendorId: vendor.id)),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Header(vendor: vendor),
          TabBar(
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            tabs: [for (final (label, _) in tabs) Tab(text: label)],
          ),
          Expanded(child: TabBarView(children: [for (final (_, w) in tabs) w])),
        ],
      ),
    );
  }
}

class _Header extends ConsumerWidget {
  const _Header({required this.vendor});
  final VendorDetail vendor;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final v = vendor;
    final when = v.statusChangedAt == null ? null : DateFormat('d MMM yyyy').format(v.statusChangedAt!.toLocal());
    final by = [if (v.statusChangedBy != null) v.statusChangedBy!.name, ?when].join(', ');
    final decisions = VendorDecision.values.where((d) => d.allowedBy(v.allowed)).toList();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              VendorAvatar(name: v.name, url: v.summary.logoUrl, size: 52),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(v.name, style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800, color: c.ink)),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 12,
                      runSpacing: 4,
                      children: [
                        StatusText(v.status.label, color: vendorStatusColor(c, v.status)),
                        StatusText(v.summary.openState.label, color: openStateColor(c, v.summary.openState)),
                        if (v.summary.zone != null)
                          Text(v.summary.zone!.name, style: TextStyle(fontSize: 12.5, color: c.muted)),
                      ],
                    ),
                    const SizedBox(height: 4),
                    RatingText(rating: v.summary.rating, count: v.summary.rating == null ? null : v.summary.ratingCount),
                  ],
                ),
              ),
            ],
          ),
          if (v.statusReason != null) ...[
            const SizedBox(height: 10),
            Text.rich(
              TextSpan(children: [
                TextSpan(text: '${v.status.label}: ', style: const TextStyle(fontWeight: FontWeight.w700)),
                TextSpan(text: v.statusReason),
                if (by.isNotEmpty) TextSpan(text: ' · $by', style: TextStyle(color: c.muted)),
              ]),
              style: TextStyle(fontSize: 13, color: c.ink, height: 1.35),
            ),
          ],
          if (decisions.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final d in decisions)
                  d == VendorDecision.approve || d == VendorDecision.reactivate
                      ? FilledButton(
                          key: Key('vendor-action-${d.name}'),
                          onPressed: () => decideVendor(context, ref, v, d),
                          child: Text(d.label),
                        )
                      : OutlinedButton(
                          key: Key('vendor-action-${d.name}'),
                          style: d == VendorDecision.suspend || d == VendorDecision.reject
                              ? OutlinedButton.styleFrom(foregroundColor: c.deal)
                              : null,
                          onPressed: () => decideVendor(context, ref, v, d),
                          child: Text(d.label),
                        ),
              ],
            ),
          ],
          const SizedBox(height: 4),
        ],
      ),
    );
  }
}
