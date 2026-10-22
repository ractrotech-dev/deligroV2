import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/marketing.dart';
import '../../state/marketing.dart';
import '../../theme/app_theme.dart';
import '../../widgets/paged_list_view.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import 'form_bits.dart';
import 'marketing_labels.dart';

/// Campaigns (§8.4–8.12): active, scheduled and expired, by kind.
class CampaignsTab extends ConsumerStatefulWidget {
  const CampaignsTab({super.key, this.initialState = CampaignState.active, this.onOpen});
  final CampaignState initialState;

  /// Opens one campaign; defaults to pushing its detail.
  final void Function(BuildContext context, CampaignSummary c)? onOpen;

  @override
  ConsumerState<CampaignsTab> createState() => _CampaignsTabState();
}

class _CampaignsTabState extends ConsumerState<CampaignsTab> with AutomaticKeepAliveClientMixin {
  late CampaignFilters _filters = CampaignFilters(state: widget.initialState);
  CampaignCounts _counts = const CampaignCounts();

  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final zone = ref.watch(activeZoneProvider);
    final eff = _filters.zoneId != null || zone == null ? _filters : _filters.copyWith(zoneId: zone.id);
    final value = ref.watch(campaignListProvider(eff));
    if (value.value != null) _counts = value.value!.counts;
    return Column(
      children: [
        const SizedBox(height: 8),
        CountChips<CampaignState>(
          keyPrefix: 'campaign-tab',
          options: [for (final s in CampaignState.tabs) (s, s.label, _counts.of(s))],
          selected: _filters.state,
          allLabel: 'All',
          onSelected: (s) => setState(() => _filters = _filters.copyWith(state: s)),
        ),
        CountChips<CampaignKind>(
          keyPrefix: 'campaign-kind',
          options: [for (final k in CampaignKind.pickable) (k, k.label, null)],
          selected: _filters.kind,
          allLabel: 'Any type',
          onSelected: (k) => setState(() => _filters = _filters.copyWith(kind: k)),
        ),
        Expanded(
          child: PagedListView<CampaignSummary, CampaignCounts>(
            key: const Key('campaigns-list'),
            value: value,
            narrowed: true,
            filteredEmptyText: 'No campaigns here.',
            onRetry: () => ref.invalidate(campaignListProvider(eff)),
            onRefresh: () => ref.read(campaignListProvider(eff).notifier).refresh(),
            onLoadMore: () => ref.read(campaignListProvider(eff).notifier).loadMore(),
            empty: const EmptySection(icon: Icons.campaign_outlined, title: 'No campaigns', text: 'Approved requests and new campaigns appear here.'),
            itemBuilder: (context, c) => CampaignRow(
              campaign: c,
              onTap: () => widget.onOpen != null
                  ? widget.onOpen!(context, c)
                  : GoRouter.maybeOf(context)?.push('/more/marketing/campaigns/${c.id}'),
            ),
          ),
        ),
      ],
    );
  }
}

class CampaignRow extends StatelessWidget {
  const CampaignRow({super.key, required this.campaign, required this.onTap});
  final CampaignSummary campaign;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final x = campaign;
    final h = x.headline;
    return RowCard(
      key: Key('campaign-row-${x.id}'),
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Icon(campaignIcon(x.kind), color: c.accent, size: 20),
            const SizedBox(width: 10),
            Expanded(
              child: Text(x.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
            ),
            StatusText(campaignStateLabel(x), color: campaignStateColor(c, x.state, x.status)),
          ]),
          const SizedBox(height: 4),
          Text(
            [
              x.kind.label,
              if (x.vendors.isNotEmpty) x.vendors.length == 1 ? x.vendors.first.name : '${x.vendors.length} shops',
              if (x.slotPosition != null) 'slot ${x.slotPosition}',
            ].join(' · '),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 13, color: c.muted),
          ),
          const SizedBox(height: 2),
          Text('${istText(x.startsAt, time: false)} – ${istText(x.endsAt, time: false)} · ${x.fundingLabel}',
              style: TextStyle(fontSize: 12.5, color: c.muted)),
          if (x.state != CampaignState.scheduled) ...[
            const SizedBox(height: 8),
            Wrap(spacing: 16, runSpacing: 4, children: [
              _mini(context, count(h.impressions), 'views'),
              _mini(context, count(h.clicks), 'taps'),
              _mini(context, count(h.attributedOrders), 'orders'),
              _mini(context, rupees(h.attributedSales), 'sales'),
            ]),
          ],
        ],
      ),
    );
  }

  Widget _mini(BuildContext context, String v, String label) => Row(mainAxisSize: MainAxisSize.min, children: [
        Text(v, style: dataStyle(context, size: 13, weight: FontWeight.w700)),
        const SizedBox(width: 4),
        Text(label, style: TextStyle(fontSize: 12, color: context.colors.muted)),
      ]);
}
