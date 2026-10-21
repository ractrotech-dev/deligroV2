import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/vendors.dart';
import '../../state/session.dart';
import '../../state/vendors.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import 'vendor_detail_screen.dart';
import 'vendor_filters_sheet.dart';
import 'vendor_tile.dart';

/// Vendors (§4.1): every shop in this manager's zones — searchable, by status,
/// open now or needing attention, paged as the manager scrolls.
///
/// [query] is the route's URI: the dashboard's Active / Online Vendors tiles
/// open it already filtered (`/more/vendors?filter=online`).
const vendorsWideBreakpoint = 840.0;

class VendorsScreen extends ConsumerStatefulWidget {
  const VendorsScreen({super.key, this.query, this.onOpen});

  final Uri? query;

  /// Opens one vendor; defaults to pushing `/more/vendors/<id>`.
  final void Function(BuildContext context, VendorListItem vendor)? onOpen;

  @override
  ConsumerState<VendorsScreen> createState() => _VendorsScreenState();
}

class _VendorsScreenState extends ConsumerState<VendorsScreen> {
  late VendorFilters _filters;
  late final TextEditingController _search;
  final _scroll = ScrollController();
  Timer? _debounce;
  VendorCounts _counts = const VendorCounts();
  VendorFilters? _effective;
  bool _wide = false;
  String? _selected;

  @override
  void initState() {
    super.initState();
    final q = widget.query;
    _filters = q == null || q.queryParameters.isEmpty ? const VendorFilters() : VendorFilters.fromUri(q);
    _search = TextEditingController(text: _filters.q ?? '');
    _scroll.addListener(_onScroll);
  }

  @override
  void didUpdateWidget(VendorsScreen old) {
    super.didUpdateWidget(old);
    final q = widget.query;
    if (q?.toString() != old.query?.toString() && q != null && q.queryParameters.isNotEmpty) {
      _filters = VendorFilters.fromUri(q);
      _search.text = _filters.q ?? '';
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _set(VendorFilters f) {
    if (f == _filters) return;
    setState(() => _filters = f);
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  void _onSearch(String text) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () {
      final q = text.trim();
      _set(_filters.copyWith(q: q.length < 2 ? null : q));
    });
  }

  void _onScroll() {
    final eff = _effective;
    if (eff == null || !_scroll.hasClients) return;
    final p = _scroll.position;
    if (p.maxScrollExtent > 0 && p.pixels >= p.maxScrollExtent * 0.8) {
      ref.read(vendorListProvider(eff).notifier).loadMore();
    }
  }

  void _open(VendorListItem v) {
    if (_wide) {
      setState(() => _selected = v.id);
      return;
    }
    final custom = widget.onOpen;
    if (custom != null) {
      custom(context, v);
    } else {
      GoRouter.maybeOf(context)?.push('/more/vendors/${v.id}');
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final zone = ref.watch(activeZoneProvider);
    final eff = _filters.zoneId != null || zone == null ? _filters : _filters.copyWith(zoneId: zone.id);
    _effective = eff;
    final value = ref.watch(vendorListProvider(eff));
    final data = value.value;
    if (data != null) _counts = data.counts;
    final canOnboard = me?.can('manager.vendors.onboard') ?? false;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Vendors'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      floatingActionButton: canOnboard
          ? FloatingActionButton.extended(
              key: const Key('vendors-add'),
              onPressed: () => GoRouter.maybeOf(context)?.push('/more/vendors/new'),
              icon: const Icon(Icons.add_business_outlined),
              label: const Text('Add vendor'),
            )
          : null,
      body: (me?.hasNoZones ?? false)
          ? const Padding(padding: EdgeInsets.all(16), child: NoZonesNotice())
          : LayoutBuilder(builder: (context, box) {
              _wide = box.maxWidth >= vendorsWideBreakpoint;
              final list = Column(
                children: [
                  _searchRow(c, data?.items ?? const []),
                  _tabs(),
                  _chips(),
                  Expanded(child: _list(value, eff)),
                ],
              );
              if (!_wide) return list;
              return Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(width: 420, child: list),
                  VerticalDivider(width: 1, color: c.line),
                  Expanded(
                    child: _selected == null
                        ? Center(child: Text('Pick a vendor to see it here.', style: TextStyle(color: c.muted)))
                        : VendorDetailBody(key: ValueKey(_selected), vendorId: _selected!),
                  ),
                ],
              );
            }),
    );
  }

  Widget _searchRow(AppColors c, List<VendorListItem> loaded) {
    final categories = {for (final v in loaded) if (v.category != null) v.category!}.toList()..sort();
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              key: const Key('vendors-search'),
              controller: _search,
              onChanged: _onSearch,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                isDense: true,
                prefixIcon: const Icon(Icons.search),
                hintText: 'Shop name',
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
            isLabelVisible: _filters.category != null,
            label: const Text('1'),
            backgroundColor: c.accent,
            textColor: c.onAccent,
            child: IconButton.outlined(
              key: const Key('vendors-filters'),
              tooltip: 'Filters',
              onPressed: () async {
                final next = await showVendorFiltersSheet(context, current: _filters, categories: categories);
                if (next != null && mounted) _set(next);
              },
              icon: const Icon(Icons.tune),
            ),
          ),
        ],
      ),
    );
  }

  Widget _tabs() {
    final selected = _filters.statuses.length == 1 ? _filters.statuses.first : null;
    final none = _filters.statuses.isEmpty;
    Widget tab(String key, String label, VendorStatus? s) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            key: Key('vendor-tab-$key'),
            label: Text(label),
            selected: s == null ? none : selected == s,
            onSelected: (_) => _set(_filters.copyWith(statuses: s == null ? const {} : {s})),
          ),
        );
    String n(String label, VendorStatus s) => '$label (${_counts.of(s)})';
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      child: Row(
        children: [
          tab('all', 'All', null),
          tab('pending', n('Pending', VendorStatus.pending), VendorStatus.pending),
          tab('active', n('Active', VendorStatus.active), VendorStatus.active),
          tab('suspended', n('Suspended', VendorStatus.suspended), VendorStatus.suspended),
          tab('rejected', n('Rejected', VendorStatus.rejected), VendorStatus.rejected),
          tab('inactive', n('Inactive', VendorStatus.inactive), VendorStatus.inactive),
        ],
      ),
    );
  }

  Widget _chips() {
    Widget chip(String key, String label, VendorQuickFilter f) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: FilterChip(
            key: Key('vendor-chip-$key'),
            label: Text(label),
            selected: _filters.filter == f,
            onSelected: (on) => _set(_filters.copyWith(filter: on ? f : null)),
          ),
        );
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 6),
      child: Row(
        children: [
          chip('online', 'Open now (${_counts.online})', VendorQuickFilter.online),
          chip('attention', 'Needs attention', VendorQuickFilter.needsAttention),
          if (_filters.category != null)
            InputChip(
              key: const Key('vendor-chip-category'),
              label: Text(_filters.category!),
              onDeleted: () => _set(_filters.copyWith(category: null)),
              deleteButtonTooltipMessage: 'Remove',
            ),
        ],
      ),
    );
  }

  Widget _list(AsyncValue<VendorList> value, VendorFilters eff) {
    final data = value.value;
    if (data == null) {
      if (value.hasError) {
        final e = value.error!;
        if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
        return ErrorRetry(error: e, onRetry: () => ref.invalidate(vendorListProvider(eff)));
      }
      return ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        itemCount: 6,
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (_, _) => const VendorTileSkeleton(),
      );
    }

    Future<void> pull() => ref.read(vendorListProvider(eff).notifier).refresh();

    if (data.items.isEmpty) {
      return RefreshIndicator(
        onRefresh: pull,
        child: ListView(
          key: const Key('vendors-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            if (_filters.narrowed)
              const EmptyLine('No vendors match these filters.')
            else
              const _NoVendors(),
          ],
        ),
      );
    }

    final footer = data.hasMore || data.loadingMore || data.loadMoreFailed;
    return RefreshIndicator(
      onRefresh: pull,
      child: ListView.separated(
        key: const Key('vendors-list'),
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 96),
        itemCount: data.items.length + (footer ? 1 : 0),
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          if (i == data.items.length) {
            if (data.loadMoreFailed) {
              return Center(
                child: TextButton(
                  onPressed: () => ref.read(vendorListProvider(eff).notifier).loadMore(),
                  child: const Text("Couldn't load more — tap to retry"),
                ),
              );
            }
            return const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4))),
            );
          }
          final v = data.items[i];
          return VendorTile(vendor: v, selected: _wide && v.id == _selected, onTap: () => _open(v));
        },
      ),
    );
  }
}

class _NoVendors extends StatelessWidget {
  const _NoVendors();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(32, 96, 32, 32),
      child: Column(
        children: [
          Icon(Icons.storefront_outlined, size: 44, color: c.muted),
          const SizedBox(height: 12),
          Text('No vendors yet', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)),
          const SizedBox(height: 6),
          Text(
            'Shops registered in your zones appear here.',
            textAlign: TextAlign.center,
            style: TextStyle(color: c.muted, fontSize: 14),
          ),
        ],
      ),
    );
  }
}
