import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/i18n.dart';
import '../../models/order.dart';
import '../../state/orders.dart';
import '../../theme/app_theme.dart';
import '../../widgets/stage.dart';
import '../more/ring_setup.dart';
import 'history_view.dart';
import 'order_card.dart';

/// Orders: the live board (New → Ready → out for delivery) and past orders.
class OrdersScreen extends ConsumerWidget {
  const OrdersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final live = ref.watch(boardProvider).value?.orders.length;
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: Text(tr(ref, 'Orders', 'ऑर्डर')),
          bottom: TabBar(
            tabs: [
              Tab(text: live == null ? tr(ref, 'Live', 'चालू') : '${tr(ref, 'Live', 'चालू')} ($live)'),
              Tab(text: tr(ref, 'Past', 'पुराने')),
            ],
          ),
        ),
        body: const TabBarView(children: [_LiveBoard(), HistoryView()]),
      ),
    );
  }
}

/// A chip filter on the live board. `null` stage = all.
enum _Filter { all, newOrder, accepted, preparing, ready, outForDelivery }

class _LiveBoard extends ConsumerStatefulWidget {
  const _LiveBoard();

  @override
  ConsumerState<_LiveBoard> createState() => _LiveBoardState();
}

class _LiveBoardState extends ConsumerState<_LiveBoard> {
  _Filter _filter = _Filter.all;
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
        return _Message(
          icon: Icons.cloud_off_rounded,
          title: tr(ref, 'Orders couldn\'t load', 'ऑर्डर लोड नहीं हुए'),
          body: e is ApiException ? e.friendly(hi: isHindi(ref)) : tr(ref, 'Check your internet.', 'इंटरनेट देखें।'),
          action: tr(ref, 'Retry', 'फिर कोशिश करें'),
          onAction: () => ref.invalidate(boardProvider),
        );
      }
      return const Center(child: CircularProgressIndicator());
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
          _Filter.all => tr(ref, 'All', 'सभी'),
          _Filter.newOrder => stageLabel(ref, OrderStage.newOrder),
          _Filter.accepted => stageLabel(ref, OrderStage.accepted),
          _Filter.preparing => stageLabel(ref, OrderStage.preparing),
          _Filter.ready => tr(ref, 'Ready', 'तैयार'),
          _Filter.outForDelivery => tr(ref, 'Out for delivery', 'डिलीवरी पर'),
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
                        tr(ref, 'Can\'t refresh — showing the last orders we loaded.',
                            'रिफ्रेश नहीं हो रहा — पिछली बार लोड हुए ऑर्डर दिख रहे हैं।'),
                        style: TextStyle(color: c.deal, fontSize: 13, fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
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
                  hintText: tr(ref, 'Search by order ID or customer name', 'ऑर्डर ID या ग्राहक के नाम से खोजें'),
                  prefixIcon: const Icon(Icons.search_rounded),
                  suffixIcon: _search.text.isEmpty
                      ? null
                      : IconButton(
                          tooltip: tr(ref, 'Clear search', 'खोज हटाएँ'),
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
              child: _Message(
                icon: Icons.receipt_long_outlined,
                title: state.orders.isEmpty
                    ? tr(ref, 'No live orders right now', 'अभी कोई चालू ऑर्डर नहीं')
                    : tr(ref, 'Nothing matches', 'कुछ नहीं मिला'),
                body: state.orders.isEmpty
                    ? tr(ref, 'New orders appear here and ring the phone.', 'नए ऑर्डर यहाँ दिखेंगे और फ़ोन बजेगा।')
                    : tr(ref, 'Try another filter or search.', 'दूसरा फ़िल्टर या खोज आज़माएँ।'),
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

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.title, required this.body, this.action, this.onAction});
  final IconData icon;
  final String title;
  final String body;
  final String? action;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 42, color: c.muted),
            const SizedBox(height: 12),
            Text(title, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(body, textAlign: TextAlign.center, style: TextStyle(color: c.muted)),
            if (action != null) ...[
              const SizedBox(height: 16),
              FilledButton(onPressed: onAction, child: Text(action!)),
            ],
          ],
        ),
      ),
    );
  }
}
