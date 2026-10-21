import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../models/orders.dart';
import '../../state/orders.dart';
import '../../state/vendors.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/polling.dart';
import '../../widgets/zone_picker.dart';
import 'order_detail_screen.dart';
import 'order_filters_sheet.dart';
import 'order_labels.dart';
import 'order_tile.dart';

/// The Orders tab (§3.1–3.7, §3.12–3.13): every order across this manager's
/// zones, searchable by code, filterable, in queues for what needs attention,
/// paged as the manager scrolls, re-asked every 10 s while on screen.
///
/// [query] is the route's URI: a dashboard tile or a push opens the tab
/// already filtered (`/orders?status=pending`, `?queue=delayed`, …).
/// At this width and wider the Orders tab shows the list and the chosen
/// order side by side (design: ≥ 840 dp).
const wideBreakpoint = 840.0;

class OrdersScreen extends ConsumerStatefulWidget {
  const OrdersScreen({super.key, this.query, this.onOpen});

  final Uri? query;

  /// Opens one order; defaults to pushing `/orders/<id>`.
  final void Function(BuildContext context, OrderListItem order)? onOpen;

  @override
  ConsumerState<OrdersScreen> createState() => _OrdersScreenState();
}

class _OrdersScreenState extends ConsumerState<OrdersScreen> {
  late OrderFilters _filters;
  late final TextEditingController _search;
  final _scroll = ScrollController();
  Timer? _debounce;
  QueueCounts _counts = const QueueCounts();
  OrderFilters? _effective;
  bool _wide = false;
  String? _selected;

  @override
  void initState() {
    super.initState();
    _filters = _fromQuery(widget.query) ?? const OrderFilters();
    _search = TextEditingController(text: _filters.q ?? '');
    _scroll.addListener(_onScroll);
  }

  OrderFilters? _fromQuery(Uri? q) => q == null || q.queryParameters.isEmpty ? null : OrderFilters.fromUri(q);

  @override
  void didUpdateWidget(OrdersScreen old) {
    super.didUpdateWidget(old);
    if (widget.query?.toString() != old.query?.toString()) {
      final next = _fromQuery(widget.query);
      if (next != null) {
        _filters = next;
        _search.text = next.q ?? '';
      }
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _set(OrderFilters f) {
    if (f == _filters) return;
    setState(() => _filters = f);
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  void _onSearch(String text) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () {
      final q = text.trim();
      _set(_filters.copyWith(q: q.isEmpty ? null : q));
    });
  }

  void _onScroll() {
    final eff = _effective;
    if (eff == null || !_scroll.hasClients) return;
    final p = _scroll.position;
    if (p.maxScrollExtent > 0 && p.pixels >= p.maxScrollExtent * 0.8) {
      ref.read(orderListProvider(eff).notifier).loadMore();
    }
  }

  void _open(OrderListItem o) {
    if (_wide) {
      setState(() => _selected = o.id);
      return;
    }
    final custom = widget.onOpen;
    if (custom != null) {
      custom(context, o);
    } else {
      GoRouter.maybeOf(context)?.push('/orders/${o.id}');
    }
  }

  Future<void> _openFilters(List<OrderListItem> loaded) async {
    final vendors = <String, VendorRef>{for (final o in loaded) o.vendor.id: o.vendor};
    // The full directory when it loads; the loaded rows' vendors otherwise.
    try {
      for (final v in await ref.read(vendorDirectoryProvider.future)) {
        vendors[v.id] = v;
      }
    } catch (_) {}
    if (!mounted) return;
    final riders = <String, RiderRef>{
      for (final o in loaded)
        if (o.rider != null) o.rider!.id: o.rider!,
    };
    final next = await showOrderFiltersSheet(
      context,
      current: _filters,
      vendors: vendors.values.toList()..sort((a, b) => a.name.compareTo(b.name)),
      riders: riders.values.toList()..sort((a, b) => a.name.compareTo(b.name)),
    );
    if (next != null && mounted) _set(next);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final zone = ref.watch(activeZoneProvider);
    final eff = _filters.zoneId != null || zone == null ? _filters : _filters.copyWith(zoneId: zone.id);
    _effective = eff;
    final value = ref.watch(orderListProvider(eff));
    final data = value.value;
    if (data != null) _counts = data.counts;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Text('Orders'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: (me?.hasNoZones ?? false)
          ? const Padding(padding: EdgeInsets.all(16), child: NoZonesNotice())
          : LayoutBuilder(builder: (context, box) {
              _wide = box.maxWidth >= wideBreakpoint;
              final list = Polling(
                interval: ordersRefresh,
                onTick: () => ref.read(orderListProvider(eff).notifier).refresh(),
                child: Column(
                  children: [
                    _searchRow(c, data?.items ?? const []),
                    _queues(),
                    _activeFilters(c),
                    Expanded(child: _list(value, eff)),
                  ],
                ),
              );
              if (!_wide) return list;
              // Tablet / landscape: the list and the chosen order side by side.
              return Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(width: 420, child: list),
                  VerticalDivider(width: 1, color: c.line),
                  Expanded(
                    child: _selected == null
                        ? Center(child: Text('Pick an order to see it here.', style: TextStyle(color: c.muted)))
                        : OrderDetailBody(key: ValueKey(_selected), orderId: _selected!),
                  ),
                ],
              );
            }),
    );
  }

  Widget _searchRow(AppColors c, List<OrderListItem> loaded) {
    final extra = [
      _filters.from != null || _filters.to != null,
      _filters.vendorId != null,
      _filters.riderId != null,
    ].where((b) => b).length +
        _filters.statuses.length +
        _filters.payments.length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              key: const Key('orders-search'),
              controller: _search,
              onChanged: _onSearch,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                isDense: true,
                prefixIcon: const Icon(Icons.search),
                hintText: 'Order code or ID',
                filled: true,
                fillColor: c.surface,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(radiusBlock), borderSide: BorderSide(color: c.line)),
                enabledBorder:
                    OutlineInputBorder(borderRadius: BorderRadius.circular(radiusBlock), borderSide: BorderSide(color: c.line)),
              ),
            ),
          ),
          const SizedBox(width: 8),
          Badge(
            isLabelVisible: extra > 0,
            label: Text('$extra'),
            backgroundColor: c.accent,
            textColor: c.onAccent,
            child: IconButton.outlined(
              key: const Key('orders-filters'),
              tooltip: 'Filters',
              onPressed: () => _openFilters(loaded),
              icon: const Icon(Icons.tune),
            ),
          ),
        ],
      ),
    );
  }

  Widget _queues() {
    final q = _filters.queue;
    Widget chip(String key, String label, OrderQueue? value) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            key: Key('queue-$key'),
            label: Text(label),
            selected: q == value,
            onSelected: (_) => _set(_filters.copyWith(queue: value)),
          ),
        );
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      child: Row(
        children: [
          chip('all', 'All', null),
          chip('delayed', 'Delayed (${_counts.delayed})', OrderQueue.delayed),
          chip('unassigned', 'Unassigned (${_counts.unassigned})',
              OrderQueue.unassigned),
          chip('cancelled', 'Cancelled', OrderQueue.cancelled),
        ],
      ),
    );
  }

  Widget _activeFilters(AppColors c) {
    final f = _filters;
    final fmt = DateFormat('d MMM, h:mm a');
    final chips = <Widget>[
      if (f.from != null || f.to != null)
        _chip('date', [
          if (f.from != null) fmt.format(f.from!.toLocal()),
          if (f.to != null) fmt.format(f.to!.toLocal()),
        ].join(' – '), () => _set(f.copyWith(from: null, to: null))),
      if (f.vendorId != null)
        _chip('vendor', f.vendorName ?? 'Vendor', () => _set(f.copyWith(vendorId: null, vendorName: null))),
      if (f.riderId != null)
        _chip('rider', f.riderName ?? 'Rider', () => _set(f.copyWith(riderId: null, riderName: null))),
      for (final s in f.statuses)
        _chip('status-$s', statusWireLabel(s), () => _set(f.copyWith(statuses: {...f.statuses}..remove(s)))),
      for (final p in f.payments)
        _chip('payment-$p', _paymentWord(p), () => _set(f.copyWith(payments: {...f.payments}..remove(p)))),
    ];
    if (chips.isEmpty) return const SizedBox(height: 4);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 6),
      child: Row(children: chips),
    );
  }

  String _paymentWord(String w) => switch (w) {
        'cod' => 'Cash',
        'online' => 'Online',
        'pending' => 'Payment pending',
        'paid' => 'Paid',
        'failed' => 'Payment failed',
        'refunded' => 'Refunded',
        _ => w,
      };

  Widget _chip(String key, String label, VoidCallback onRemove) => Padding(
        padding: const EdgeInsets.only(right: 8),
        child: InputChip(
          key: Key('filter-chip-$key'),
          label: Text(label),
          deleteIcon: const Icon(Icons.close, size: 16),
          deleteButtonTooltipMessage: 'Remove',
          onDeleted: onRemove,
        ),
      );

  Widget _list(AsyncValue<OrderListState> value, OrderFilters eff) {
    final data = value.value;
    if (data == null) {
      if (value.hasError) {
        final e = value.error!;
        if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
        return ErrorRetry(error: e, onRetry: () => ref.invalidate(orderListProvider(eff)));
      }
      return ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        itemCount: 6,
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (_, _) => const OrderTileSkeleton(),
      );
    }

    Future<void> pull() => ref.read(orderListProvider(eff).notifier).refresh();

    if (data.items.isEmpty) {
      return RefreshIndicator(
        onRefresh: pull,
        child: ListView(
          key: const Key('orders-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            if (_filters.narrowed)
              EmptyLine('No orders match these filters.')
            else
              const _NoOrders(),
          ],
        ),
      );
    }

    final footer = data.hasMore || data.loadingMore || data.loadMoreFailed;
    return RefreshIndicator(
      onRefresh: pull,
      child: ListView.separated(
        key: const Key('orders-list'),
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        itemCount: data.items.length + (footer ? 1 : 0),
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          if (i == data.items.length) {
            if (data.loadMoreFailed) {
              return Center(
                child: TextButton(
                  onPressed: () => ref.read(orderListProvider(eff).notifier).loadMore(),
                  child: Text('Couldn\'t load more — tap to retry'),
                ),
              );
            }
            return const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4))),
            );
          }
          final o = data.items[i];
          return OrderTile(order: o, selected: _wide && o.id == _selected, onTap: () => _open(o));
        },
      ),
    );
  }
}

class _NoOrders extends StatelessWidget {
  const _NoOrders();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(32, 96, 32, 32),
      child: Column(
        children: [
          Icon(Icons.receipt_long_outlined, size: 44, color: c.muted),
          const SizedBox(height: 12),
          Text('No orders yet',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)),
          const SizedBox(height: 6),
          Text(
            'Orders across your zones appear here as customers place them.',
            textAlign: TextAlign.center,
            style: TextStyle(color: c.muted, fontSize: 14),
          ),
        ],
      ),
    );
  }
}
