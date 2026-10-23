import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/secure_screens.dart';
import '../../models/rider.dart';
import '../../state/riders.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/contact_buttons.dart';
import '../../widgets/polling.dart';
import '../orders/order_labels.dart' show StatusText;
import '../vendors/vendor_tile.dart' show RatingText, VendorAvatar;
import 'rider_actions.dart';
import 'rider_money_tab.dart';
import 'rider_tabs.dart';
import 'rider_tile.dart';

/// The detail refreshes this often while on screen (the rider moves).
const riderDetailRefresh = Duration(seconds: 15);

/// One rider (§5.2–5.15): where they are and what they carry, their
/// deliveries, performance, documents, money, cash and complaints, and the
/// audited decisions this manager may take on them.
class RiderDetailScreen extends ConsumerWidget {
  const RiderDetailScreen({super.key, required this.riderId, this.requestPayout});
  final String riderId;
  final PayoutRequestOpener? requestPayout;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final name = ref.watch(riderDetailProvider(riderId)).value?.name;
    return Scaffold(
      backgroundColor: context.colors.bg,
      appBar: AppBar(title: Text(name ?? 'Rider'), backgroundColor: context.colors.bg),
      body: RiderDetailBody(riderId: riderId, requestPayout: requestPayout),
    );
  }
}

/// The detail without its app bar — also the right-hand pane on a tablet.
class RiderDetailBody extends ConsumerWidget {
  const RiderDetailBody({super.key, required this.riderId, this.requestPayout});
  final String riderId;
  final PayoutRequestOpener? requestPayout;

  @override
  Widget build(BuildContext context, WidgetRef ref) => KeyedSubtree(
        key: const Key('rider-detail-body'),
        child: Polling(
          interval: riderDetailRefresh,
          onTick: () => ref.read(riderDetailProvider(riderId).notifier).refresh(),
          child: AsyncView(
            value: ref.watch(riderDetailProvider(riderId)),
            onRetry: () => ref.invalidate(riderDetailProvider(riderId)),
            builder: (r) => _Detail(rider: r, requestPayout: requestPayout),
          ),
        ),
      );
}

class _Detail extends StatelessWidget {
  const _Detail({required this.rider, this.requestPayout});
  final RiderDetail rider;
  final PayoutRequestOpener? requestPayout;

  @override
  Widget build(BuildContext context) {
    final r = rider;
    final tabs = <(String, Widget)>[
      ('Overview', RiderOverviewTab(rider: r)),
      ('Deliveries', RiderDeliveriesTab(riderId: r.id)),
      ('Performance', RiderPerformanceTab(rider: r)),
      ('Documents', RiderDocumentsTab(rider: r)),
      if (r.money != null) ('Money', SecureScope(child: RiderMoneyTab(rider: r, money: r.money!, requestPayout: requestPayout))),
      ('Cash', RiderCashTab(rider: r)),
      ('Complaints', RiderComplaintsTab(rider: r)),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: NestedScrollView(
        headerSliverBuilder: (_, _) => [SliverToBoxAdapter(child: _Header(rider: r))],
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TabBar(
              isScrollable: true,
              tabAlignment: TabAlignment.start,
              tabs: [for (final (label, _) in tabs) Tab(text: label)],
            ),
            Expanded(child: TabBarView(children: [for (final (_, w) in tabs) w])),
          ],
        ),
      ),
    );
  }
}

class _Header extends ConsumerWidget {
  const _Header({required this.rider});
  final RiderDetail rider;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final r = rider;
    final s = r.summary;
    final when = r.accountChangedAt == null ? null : DateFormat('d MMM yyyy').format(r.accountChangedAt!.toLocal());
    final by = [if (r.accountChangedBy != null) r.accountChangedBy!.name, ?when].join(', ');
    final decisions = RiderDecision.values.where((d) => d.allowedBy(r.allowed)).toList();
    final stale = s.fixAgeSeconds == null || s.fixAgeSeconds! > staleFixSeconds;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              VendorAvatar(name: r.name, url: s.photoUrl, size: 52),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            r.name,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800, color: c.ink),
                          ),
                        ),
                        if (s.riderCode != null) ...[
                          const SizedBox(width: 8),
                          Text(s.riderCode!, style: dataStyle(context, size: 13).copyWith(color: c.muted)),
                        ],
                      ],
                    ),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 12,
                      runSpacing: 4,
                      children: [
                        StatusText(s.state.label, color: riderStateColor(c, s.state)),
                        StatusText(s.verification.label, color: verificationColor(c, s.verification)),
                        if (s.account != RiderAccount.active)
                          StatusText(s.account.label, color: accountColor(c, s.account)),
                        Text(fixAgeText(s.fixAgeSeconds),
                            style: TextStyle(fontSize: 12.5, color: stale ? c.muted : c.ink)),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        RatingText(rating: s.rating, count: s.rating == null ? null : s.ratingCount),
                        if (s.zones.isNotEmpty) ...[
                          const SizedBox(width: 12),
                          Flexible(
                            child: Text(
                              s.zones.map((z) => z.name).join(', '),
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 12.5, color: c.muted),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (r.accountReason != null) ...[
            const SizedBox(height: 10),
            Text.rich(
              TextSpan(children: [
                TextSpan(text: '${s.account.label}: ', style: const TextStyle(fontWeight: FontWeight.w700)),
                TextSpan(text: r.accountReason),
                if (by.isNotEmpty) TextSpan(text: ' · $by', style: TextStyle(color: c.muted)),
              ]),
              style: TextStyle(fontSize: 13, color: c.ink, height: 1.35),
            ),
          ],
          if (s.phone != null) ...[
            const SizedBox(height: 10),
            ContactButtons(phone: s.phone!),
          ],
          if (decisions.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final d in decisions)
                  d.destructive
                      ? OutlinedButton(
                          key: Key('rider-action-${d.wire}'),
                          style: OutlinedButton.styleFrom(foregroundColor: c.deal),
                          onPressed: () => decideRider(context, ref, r, d),
                          child: Text(d.label),
                        )
                      : FilledButton(
                          key: Key('rider-action-${d.wire}'),
                          onPressed: () => decideRider(context, ref, r, d),
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
