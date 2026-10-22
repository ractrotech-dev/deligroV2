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
import 'campaigns_tab.dart';
import 'form_bits.dart';
import 'marketing_labels.dart';
import 'request_detail_screen.dart';

/// Marketing (§8): vendors' requests to review, and the campaigns that run.
///
/// [query]: `?status=pending` (the dashboard tile) opens Requests on that
/// status; `?tab=campaigns&state=active` opens Campaigns.
class MarketingScreen extends ConsumerStatefulWidget {
  const MarketingScreen({super.key, this.query});
  final Uri? query;

  @override
  ConsumerState<MarketingScreen> createState() => _MarketingScreenState();
}

class _MarketingScreenState extends ConsumerState<MarketingScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabs;

  @override
  void initState() {
    super.initState();
    final p = widget.query?.queryParameters ?? const {};
    _tabs = TabController(length: 2, vsync: this, initialIndex: p['tab'] == 'campaigns' ? 1 : 0);
    _tabs.addListener(() {
      if (!_tabs.indexIsChanging && mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final p = widget.query?.queryParameters ?? const {};
    final onRequests = _tabs.index == 0;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Marketing'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
        bottom: TabBar(
          controller: _tabs,
          tabs: const [Tab(key: Key('marketing-tab-requests'), text: 'Requests'), Tab(key: Key('marketing-tab-campaigns'), text: 'Campaigns')],
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        key: Key(onRequests ? 'request-new' : 'campaign-new'),
        backgroundColor: c.accent,
        foregroundColor: c.onAccent,
        elevation: 2,
        onPressed: () => GoRouter.maybeOf(context)?.push(onRequests ? '/more/marketing/requests/new' : '/more/marketing/campaigns/new'),
        icon: Icon(onRequests ? Icons.post_add_outlined : Icons.add),
        label: Text(onRequests ? 'Record a request' : 'New campaign'),
      ),
      body: TabBarView(
        controller: _tabs,
        children: [
          _RequestsTab(initial: RequestFilters.fromUri(widget.query ?? Uri())),
          CampaignsTab(initialState: switch (p['state']) {
            'scheduled' => CampaignState.scheduled,
            'expired' => CampaignState.expired,
            _ => CampaignState.active,
          }),
        ],
      ),
    );
  }
}

class _RequestsTab extends ConsumerStatefulWidget {
  const _RequestsTab({required this.initial});
  final RequestFilters initial;

  @override
  ConsumerState<_RequestsTab> createState() => _RequestsTabState();
}

class _RequestsTabState extends ConsumerState<_RequestsTab> with AutomaticKeepAliveClientMixin {
  late RequestFilters _filters = widget.initial;
  RequestCounts _counts = const RequestCounts();
  String? _selected;

  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final c = context.colors;
    final zone = ref.watch(activeZoneProvider);
    final eff = _filters.zoneId != null || zone == null ? _filters : _filters.copyWith(zoneId: zone.id);
    final value = ref.watch(requestListProvider(eff));
    if (value.value != null) _counts = value.value!.counts;

    final list = Column(
      children: [
        const SizedBox(height: 8),
        CountChips<RequestStatus>(
          keyPrefix: 'request-tab',
          options: [for (final s in RequestStatus.tabs) (s, s.label, _counts.of(s))],
          selected: _filters.status,
          allLabel: 'All',
          onSelected: (s) => setState(() => _filters = _filters.copyWith(status: s)),
        ),
        CountChips<MarketingType>(
          keyPrefix: 'request-type',
          options: [for (final t in MarketingType.pickable) (t, t.label, null)],
          selected: _filters.type,
          allLabel: 'Any type',
          onSelected: (t) => setState(() => _filters = _filters.copyWith(type: t)),
        ),
        Expanded(
          child: PagedListView<MarketingRequest, RequestCounts>(
            key: const Key('requests-list'),
            value: value,
            narrowed: _filters.narrowed || _filters.status != null,
            filteredEmptyText: 'No requests here.',
            onRetry: () => ref.invalidate(requestListProvider(eff)),
            onRefresh: () => ref.read(requestListProvider(eff).notifier).refresh(),
            onLoadMore: () => ref.read(requestListProvider(eff).notifier).loadMore(),
            empty: const EmptySection(
              icon: Icons.campaign_outlined,
              title: 'No marketing requests yet',
              text: 'Requests vendors send from the Partner app appear here.',
            ),
            itemBuilder: (context, r) => _RequestRow(
              request: r,
              selected: r.id == _selected,
              onTap: () => _open(r),
            ),
          ),
        ),
      ],
    );

    return LayoutBuilder(builder: (context, box) {
      if (box.maxWidth < 840) return list;
      return Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(width: 420, child: list),
          VerticalDivider(width: 1, color: c.line),
          Expanded(
            child: _selected == null
                ? Center(child: Text('Pick a request to see it here.', style: TextStyle(color: c.muted)))
                : RequestDetailBody(key: ValueKey(_selected), requestId: _selected!),
          ),
        ],
      );
    });
  }

  void _open(MarketingRequest r) {
    if (MediaQuery.sizeOf(context).width >= 840) {
      setState(() => _selected = r.id);
    } else {
      GoRouter.maybeOf(context)?.push('/more/marketing/requests/${r.id}');
    }
  }
}

class _RequestRow extends StatelessWidget {
  const _RequestRow({required this.request, required this.onTap, this.selected = false});
  final MarketingRequest request;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = request;
    final window = r.preferredStart == null ? null : '${istDay(r.preferredStart)} – ${istDay(r.preferredEnd)}';
    return RowCard(
      key: Key('request-row-${r.id}'),
      selected: selected,
      onTap: onTap,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(requestIcon(r.type), color: c.accent),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(r.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
                const SizedBox(height: 2),
                Text('${r.vendor.name} · ${r.type.label}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13, color: c.muted)),
                const SizedBox(height: 6),
                Wrap(spacing: 12, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                  StatusText(r.status.label, color: requestStatusColor(c, r.status)),
                  if (window != null) Text(window, style: TextStyle(fontSize: 12, color: c.muted)),
                  if (r.budget != null) Text(rupees(r.budget!), style: dataStyle(context, size: 12)),
                  if (r.source == 'ops') Text('Recorded by Deligro', style: TextStyle(fontSize: 12, color: c.muted)),
                ]),
              ],
            ),
          ),
          Text('#${r.number}', style: dataStyle(context, size: 12, weight: FontWeight.w500)),
        ],
      ),
    );
  }
}
