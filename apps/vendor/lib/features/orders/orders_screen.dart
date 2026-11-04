import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../models/order.dart';
import '../../state/orders.dart';
import '../../theme/app_theme.dart';
import '../../widgets/stage.dart';
import '../../widgets/states.dart';
import '../more/ring_setup.dart';
import 'history_view.dart';
import 'order_card.dart';

/// Orders: the live board (New → Ready → out for delivery) and past orders.
class OrdersScreen extends ConsumerWidget {
  const OrdersScreen({super.key, this.filter, this.tab, this.kind});

  /// From a dashboard tile: `new`, `accepted`, `preparing`, `ready`.
  final String? filter;

  /// `past` opens Past orders; [kind] `cancelled` opens the cancelled list.
  final String? tab;
  final String? kind;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final live = ref.watch(boardProvider).value?.orders.length;
    return DefaultTabController(
      key: ValueKey('$filter|$tab|$kind'),
      length: 2,
      initialIndex: tab == 'past' ? 1 : 0,
      child: Scaffold(
        appBar: AppBar(
          title: Text('Orders'),
          bottom: TabBar(
            tabs: [
              Tab(text: live == null ? 'Live' : '${'Live'} ($live)'),
              Tab(text: 'Past'),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _LiveBoard(initial: filter),
            HistoryView(initialKind: kind),
          ],
        ),
      ),
    );
  }
}

/// A chip filter on the live board. `null` stage = all.
enum _Filter { all, newOrder, accepted, preparing, ready, outForDelivery }

class _LiveBoard extends ConsumerStatefulWidget {
  const _LiveBoard({this.initial});
  final String? initial;

  @override
  ConsumerState<_LiveBoard> createState() => _LiveBoardState();
}

class _LiveBoardState extends ConsumerState<_LiveBoard> {
  late _Filter _filter = switch (widget.initial) {
    'new' => _Filter.newOrder,
    'accepted' => _Filter.accepted,
    'preparing' => _Filter.preparing,
    'ready' => _Filter.ready,
    'out' => _Filter.outForDelivery,
    _ => _Filter.all,
  };
  final _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    _search.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  bool _keep(VendorOrder o) {
    final byStage = switch (_filter) {
      _Filter.all => true,
      _Filter.newOrder => o.stage == OrderStage.newOrder,
      _Filter.accepted => o.stage == OrderStage.accepted,
      _Filter.preparing => o.stage == OrderStage.preparing,
      _Filter.ready => o.stage == OrderStage.ready,
      _Filter.outForDelivery => o.status == 'on_the_way',
    };
    return byStage && o.matches(_search.text);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final board = ref.watch(boardProvider);
    final state = board.value;

    if (state == null) {
      if (board.hasError) {
        final e = board.error;
        return StateMessage(
          icon: Icons.cloud_off_rounded,
          title: 'Orders couldn\'t load',
          body: e is ApiException ? e.friendly() : 'Check your internet.',
          action: 'Retry',
          onAction: () => ref.invalidate(boardProvider),
        );
      }
      return ListView(
        physics: const NeverScrollableScrollPhysics(),
        padding: const EdgeInsets.only(top: 12),
        children: const [OrderListSkeleton()],
      );
    }

    final counts = {
      _Filter.all: state.orders.length,
      _Filter.newOrder: state.count(OrderStage.newOrder),
      _Filter.accepted: state.count(OrderStage.accepted),
      _Filter.preparing: state.count(OrderStage.preparing),
      _Filter.ready: state.count(OrderStage.ready),
      _Filter.outForDelivery: state.outForDelivery,
    };
    String label(_Filter f) => switch (f) {
      _Filter.all => 'All',
      _Filter.newOrder => stageLabel(ref, OrderStage.newOrder),
      _Filter.accepted => stageLabel(ref, OrderStage.accepted),
      _Filter.preparing => stageLabel(ref, OrderStage.preparing),
      _Filter.ready => 'Ready',
      _Filter.outForDelivery => 'Out for delivery',
    };
    final shown = state.orders.where(_keep).toList();

    return RefreshIndicator(
      onRefresh: () => ref.read(boardProvider.notifier).refresh(),
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          const SliverToBoxAdapter(
            child: Padding(padding: EdgeInsets.fromLTRB(16, 12, 16, 0), child: RingWarningBanner()),
          ),
          if (state.stale)
            SliverToBoxAdapter(
              child: Semantics(
                liveRegion: true,
                child: Container(
                  margin: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(12)),
                  child: Row(
                    children: [
                      Icon(Icons.wifi_off_rounded, color: c.deal, size: 18),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'Can\'t refresh. Showing the last orders we loaded.',
                          style: TextStyle(color: c.deal, fontSize: 13, fontWeight: FontWeight.w600),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          SliverToBoxAdapter(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
              child: Row(
                children: [
                  for (final f in _Filter.values) ...[
                    ChoiceChip(
                      label: Text('${label(f)} (${counts[f]})'),
                      selected: _filter == f,
                      showCheckmark: false,
                      onSelected: (_) => setState(() => _filter = f),
                      selectedColor: c.ink,
                      labelStyle: TextStyle(
                        color: _filter == f ? c.bg : c.ink,
                        fontWeight: _filter == f ? FontWeight.w800 : FontWeight.w600,
                        fontSize: 13,
                      ),
                    ),
                    const SizedBox(width: 8),
                  ],
                ],
              ),
            ),
          ),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: TextField(
                controller: _search,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  isDense: true,
                  hintText: 'Search by order ID or customer name',
                  prefixIcon: const Icon(Icons.search_rounded),
                  suffixIcon: _search.text.isEmpty
                      ? null
                      : IconButton(
                          tooltip: 'Clear search',
                          onPressed: _search.clear,
                          icon: const Icon(Icons.close_rounded),
                        ),
                ),
              ),
            ),
          ),
          if (shown.isEmpty)
            SliverFillRemaining(
              hasScrollBody: false,
              child: StateMessage(
                icon: Icons.receipt_long_outlined,
                title: state.orders.isEmpty ? 'No live orders right now' : 'Nothing matches',
                body: state.orders.isEmpty
                    ? 'New orders appear here and ring the phone.'
                    : 'Try another filter or search.',
              ),
            )
          else
            SliverList.builder(
              itemCount: shown.length,
              itemBuilder: (_, i) => OrderCard(order: shown[i]),
            ),
          const SliverToBoxAdapter(child: SizedBox(height: 24)),
        ],
      ),
    );
  }
}
