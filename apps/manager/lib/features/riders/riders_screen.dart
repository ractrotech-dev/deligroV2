import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/rider.dart';
import '../../state/riders.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/polling.dart';
import '../../widgets/zone_picker.dart';
import 'rider_tile.dart';

/// Riders (§5.1, §5.4–5.6): everyone delivering in this manager's zones —
/// live state and last fix, searchable by name, phone or rider code, paged as
/// the manager scrolls, refreshed every 30 s while on screen.
///
/// [query] is the route's URI: the dashboard's rider tiles open it already
/// filtered (`?account=active`, `?state=online,available,on_delivery`,
/// `?state=on_delivery`).
const ridersWideBreakpoint = 840.0;
const ridersRefresh = Duration(seconds: 30);

class RidersScreen extends ConsumerStatefulWidget {
  const RidersScreen({super.key, this.query, this.onOpen, this.detailPane});

  final Uri? query;

  /// Opens one rider; defaults to pushing `/more/riders/<id>`.
  final void Function(BuildContext context, RiderListItem rider)? onOpen;

  /// The right-hand pane on a tablet.
  final Widget Function(String riderId)? detailPane;

  @override
  ConsumerState<RidersScreen> createState() => _RidersScreenState();
}

class _RidersScreenState extends ConsumerState<RidersScreen> {
  late RiderFilters _filters;
  late final TextEditingController _search;
  final _scroll = ScrollController();
  Timer? _debounce;
  RiderCounts _counts = const RiderCounts();
  RiderFilters? _effective;
  bool _wide = false;
  String? _selected;

  @override
  void initState() {
    super.initState();
    final q = widget.query;
    _filters = q == null || q.queryParameters.isEmpty ? const RiderFilters() : RiderFilters.fromUri(q);
    _search = TextEditingController(text: _filters.q ?? '');
    _scroll.addListener(_onScroll);
  }

  @override
  void didUpdateWidget(RidersScreen old) {
    super.didUpdateWidget(old);
    final q = widget.query;
    if (q?.toString() != old.query?.toString() && q != null && q.queryParameters.isNotEmpty) {
      _filters = RiderFilters.fromUri(q);
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

  void _set(RiderFilters f) {
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
      ref.read(riderListProvider(eff).notifier).loadMore();
    }
  }

  void _open(RiderListItem r) {
    if (_wide && widget.detailPane != null) {
      setState(() => _selected = r.id);
      return;
    }
    final custom = widget.onOpen;
    if (custom != null) {
      custom(context, r);
    } else {
      GoRouter.maybeOf(context)?.push('/more/riders/${r.id}');
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final zone = ref.watch(activeZoneProvider);
    final eff = _filters.zoneId != null || zone == null ? _filters : _filters.copyWith(zoneId: zone.id);
    _effective = eff;
    final value = ref.watch(riderListProvider(eff));
    final data = value.value;
    if (data != null) _counts = data.counts;
    final canOnboard = me?.can('manager.riders.onboard') ?? false;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Riders'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      floatingActionButton: canOnboard
          ? FloatingActionButton.extended(
              key: const Key('riders-add'),
              backgroundColor: c.accent,
              foregroundColor: c.onAccent,
              elevation: 2,
              onPressed: () => GoRouter.maybeOf(context)?.push('/more/riders/new'),
              icon: const Icon(Icons.person_add_alt_1_outlined),
              label: const Text('Add rider'),
            )
          : null,
      body: (me?.hasNoZones ?? false)
          ? const Padding(padding: EdgeInsets.all(16), child: NoZonesNotice())
          : Polling(
              interval: ridersRefresh,
              onTick: () => ref.read(riderListProvider(eff).notifier).refresh(),
              child: LayoutBuilder(
                builder: (context, box) {
                  _wide = box.maxWidth >= ridersWideBreakpoint;
                  final list = Column(
                    children: [
                      _searchRow(c),
                      _tabs(),
                      _chips(),
                      Expanded(child: _list(value, eff)),
                    ],
                  );
                  final pane = widget.detailPane;
                  if (!_wide || pane == null) return list;
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      SizedBox(width: 420, child: list),
                      VerticalDivider(width: 1, color: c.line),
                      Expanded(
                        child: _selected == null
                            ? Center(child: Text('Pick a rider to see them here.', style: TextStyle(color: c.muted)))
                            : KeyedSubtree(key: ValueKey(_selected), child: pane(_selected!)),
                      ),
                    ],
                  );
                },
              ),
            ),
    );
  }

  Widget _searchRow(AppColors c) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
        child: TextField(
          key: const Key('riders-search'),
          controller: _search,
          onChanged: _onSearch,
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            isDense: true,
            prefixIcon: const Icon(Icons.search),
            hintText: 'Name, phone or rider code',
            filled: true,
            fillColor: c.surface,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(radiusBlock),
              borderSide: BorderSide(color: c.line),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(radiusBlock),
              borderSide: BorderSide(color: c.line),
            ),
          ),
        ),
      );

  Widget _tabs() {
    final selected = _filters.states.length == 1 ? _filters.states.first : null;
    final none = _filters.states.isEmpty;
    Widget tab(String key, String label, RiderState? s) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            key: Key('rider-tab-$key'),
            label: Text(label),
            selected: s == null ? none : selected == s,
            onSelected: (_) => _set(_filters.copyWith(states: s == null ? const {} : {s})),
          ),
        );
    String n(String label, RiderState s) => '$label (${_counts.of(s)})';
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      child: Row(
        children: [
          tab('all', 'All', null),
          tab('available', n('Available', RiderState.available), RiderState.available),
          tab('on_delivery', n('On delivery', RiderState.onDelivery), RiderState.onDelivery),
          tab('break', n('Break', RiderState.onBreak), RiderState.onBreak),
          tab('offline', n('Offline', RiderState.offline), RiderState.offline),
          // A multi-state deep link (the dashboard's Online Riders) shows as
          // its own selected chip rather than silently dropping states.
          if (_filters.states.length > 1)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ChoiceChip(
                key: const Key('rider-tab-mixed'),
                label: Text(_filters.states.map((s) => s.label).join(' + ')),
                selected: true,
                onSelected: (_) {},
              ),
            ),
        ],
      ),
    );
  }

  Widget _chips() {
    Widget chip(String key, String label, bool on, ValueChanged<bool> set) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: FilterChip(key: Key('rider-chip-$key'), label: Text(label), selected: on, onSelected: set),
        );
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 6),
      child: Row(
        children: [
          chip(
            'needs_review',
            'Needs review (${_counts.needsReview})',
            _filters.filter == RiderQuickFilter.needsReview,
            (on) => _set(_filters.copyWith(filter: on ? RiderQuickFilter.needsReview : null)),
          ),
          chip(
            'expiring',
            'Documents expiring',
            _filters.filter == RiderQuickFilter.expiring,
            (on) => _set(_filters.copyWith(filter: on ? RiderQuickFilter.expiring : null)),
          ),
          chip(
            'suspended',
            'Suspended (${_counts.suspended})',
            _filters.account == RiderAccount.suspended,
            (on) => _set(_filters.copyWith(account: on ? RiderAccount.suspended : null)),
          ),
          if (_filters.account == RiderAccount.active)
            InputChip(
              key: const Key('rider-chip-active'),
              label: const Text('Active accounts'),
              onDeleted: () => _set(_filters.copyWith(account: null)),
              deleteButtonTooltipMessage: 'Remove',
            ),
        ],
      ),
    );
  }

  Widget _list(AsyncValue<RiderList> value, RiderFilters eff) {
    final data = value.value;
    if (data == null) {
      if (value.hasError) {
        final e = value.error!;
        if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
        return ErrorRetry(error: e, onRetry: () => ref.invalidate(riderListProvider(eff)));
      }
      return ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        itemCount: 6,
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (_, _) => const RiderTileSkeleton(),
      );
    }

    Future<void> pull() => ref.read(riderListProvider(eff).notifier).refresh();

    if (data.items.isEmpty) {
      return RefreshIndicator(
        onRefresh: pull,
        child: ListView(
          key: const Key('riders-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [if (_filters.narrowed) const EmptyLine('No riders match these filters.') else const _NoRiders()],
        ),
      );
    }

    final footer = data.hasMore || data.loadingMore || data.loadMoreFailed;
    return RefreshIndicator(
      onRefresh: pull,
      child: ListView.separated(
        key: const Key('riders-list'),
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
                  onPressed: () => ref.read(riderListProvider(eff).notifier).loadMore(),
                  child: const Text("Couldn't load more — tap to retry"),
                ),
              );
            }
            return const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4))),
            );
          }
          final r = data.items[i];
          return RiderTile(rider: r, selected: _wide && r.id == _selected, onTap: () => _open(r));
        },
      ),
    );
  }
}

class _NoRiders extends StatelessWidget {
  const _NoRiders();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(32, 96, 32, 32),
      child: Column(
        children: [
          Icon(Icons.two_wheeler_outlined, size: 44, color: c.muted),
          const SizedBox(height: 12),
          Text('No riders yet', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)),
          const SizedBox(height: 6),
          Text(
            'Riders working in your zones appear here.',
            textAlign: TextAlign.center,
            style: TextStyle(color: c.muted, fontSize: 14),
          ),
        ],
      ),
    );
  }
}
