import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/duration_text.dart';
import '../../core/ist_time.dart';
import '../../core/money.dart';
import '../../core/format.dart' as fmt;
import '../../models/insights.dart';
import '../../models/rider_me.dart';
import '../../state/clock.dart';
import '../../state/history.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../earnings/earnings_widgets.dart' show StatusChip, earningsFeature;
import 'history_detail_screen.dart';
import 'history_filters.dart';

/// The History tab's root (`/history`).
const historyPath = '/history';

/// The `driver.history` switch in `/api/rider/me`'s `features`.
const historyFeature = 'driver.history';

/// The History tab and the delivery page under it. A link may pre-filter it:
/// `/history?range=today&outcome=delivered`.
final historyRoute = GoRoute(
  path: historyPath,
  builder: (_, state) {
    final q = state.uri.queryParameters;
    return HistoryScreen(
      range: HistoryRange.tryParse(q['range']),
      outcome: HistoryOutcome.tryParse(q['outcome']),
      notDelivered: q['outcome'] == notDeliveredWire,
      nonce: q['n'],
    );
  },
  routes: [
    GoRoute(
      path: 'order/:id',
      builder: (_, state) => HistoryDetailScreen(
        orderId: state.pathParameters['id']!,
        preview: state.extra is HistoryItem ? state.extra as HistoryItem : null,
      ),
    ),
  ],
);

/// The `outcome=` value of a link that asks for every job not delivered.
const notDeliveredWire = 'not_delivered';

/// A link into History, pre-filtered. [outcome] is a [HistoryOutcome.wire] or
/// [notDeliveredWire]; null means all. Every link carries a fresh `n`, so
/// tapping the same Home tile twice applies the filter twice, even after the
/// rider changed it by hand.
String historyLink({required HistoryRange range, String? outcome}) => Uri(
  path: historyPath,
  queryParameters: {
    'range': range.wire,
    'outcome': ?outcome,
    'n': '${DateTime.now().microsecondsSinceEpoch}-${_linkSeq++}',
  },
).toString();

int _linkSeq = 0;

/// Where a deep link into History goes while the rider's `driver.history`
/// switch is off: Home. Null when the page may open.
String? historyRedirect(String path, RiderMe? me) {
  final inHistory = path == historyPath || path.startsWith('$historyPath/');
  if (inHistory && me != null && !me.feature(historyFeature)) return '/home';
  return null;
}

/// Every job the rider has finished, in every outcome, newest first, with a
/// date range and an outcome filter. Jobs are filed under the day they ended.
class HistoryScreen extends ConsumerStatefulWidget {
  const HistoryScreen({
    super.key,
    this.range,
    this.outcome,
    this.notDelivered = false,
    this.nonce,
  });

  /// A link's pre-filter. When [range] is set the outcome is the link's too
  /// (null = all, or [notDelivered]).
  final HistoryRange? range;
  final HistoryOutcome? outcome;
  final bool notDelivered;

  /// Changes with every link from Home, so the same filter is applied again.
  final String? nonce;

  @override
  ConsumerState<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends ConsumerState<HistoryScreen> {
  final _scroll = ScrollController();

  /// The first load has been asked for (see [_apply]).
  bool _started = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_maybeLoadMore);
    Future.microtask(_apply);
  }

  @override
  void didUpdateWidget(HistoryScreen old) {
    super.didUpdateWidget(old);
    if (old.range != widget.range ||
        old.outcome != widget.outcome ||
        old.notDelivered != widget.notDelivered ||
        old.nonce != widget.nonce) {
      Future.microtask(() => _apply(force: old.nonce != widget.nonce));
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  HistoryListNotifier get _list => ref.read(historyListProvider.notifier);

  void _apply({bool force = false}) {
    if (!mounted) return;
    _started = true;
    final r = widget.range;
    if (r != null) {
      _list.setFilter(
        HistoryFilter(
          range: r,
          outcome: widget.outcome,
          notDelivered: widget.notDelivered,
        ),
        force: force,
      );
    } else {
      final s = ref.read(historyListProvider);
      if (!s.loaded && !s.loading) _list.load();
    }
  }

  void _maybeLoadMore() {
    if (!_scroll.hasClients) return;
    // After a failed page only the "Try again" button asks again.
    if (ref.read(historyListProvider).moreError != null) return;
    if (_scroll.position.extentAfter < 400) _list.loadMore();
  }

  Future<void> _pickRange(HistoryRange r) async {
    final f = ref.read(historyListProvider).filter;
    if (r != HistoryRange.custom) {
      _list.setFilter(f.withRange(r));
      return;
    }
    final now = ref.read(clockProvider)();
    final today = parseDay(istDayKey(now))!;
    final picked = await showDateRangePicker(
      context: context,
      firstDate: DateTime(today.year, today.month, today.day - 365),
      lastDate: today,
      initialDateRange: f.customFrom == null
          ? null
          : DateTimeRange(
              start: parseDay(f.customFrom)!,
              end: parseDay(f.customTo ?? f.customFrom)!,
            ),
    );
    if (picked == null || !mounted) return;
    _list.setFilter(
      f.withRange(
        HistoryRange.custom,
        from: dayKeyOf(picked.start),
        to: dayKeyOf(picked.end),
      ),
    );
  }

  Future<void> _refresh() async {
    await _list.load();
  }

  @override
  Widget build(BuildContext context) {
    final s = ref.watch(historyListProvider);
    final me = ref.watch(meProvider).value;
    final showMoney = me?.feature(earningsFeature) != false;
    final c = context.colors;
    // Short lists never scroll: look for a next page after each build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      // A list reset by another rider signing in starts over by itself.
      final now = ref.read(historyListProvider);
      if (_started && !now.loaded && !now.loading && now.error == null) {
        _list.load();
      } else {
        _maybeLoadMore();
      }
    });
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 10),
              child: Text(
                'History',
                style: Theme.of(context).textTheme.headlineSmall,
              ),
            ),
            HistoryFilterBar(
              filter: s.filter,
              onRange: _pickRange,
              onOutcome: (o) => _list.setFilter(s.filter.withOutcome(o)),
              onNotDelivered: () =>
                  _list.setFilter(s.filter.withNotDelivered()),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
              child: Text(
                'Jobs are listed under the day they ended.',
                style: TextStyle(color: c.muted, fontSize: 12.5),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _refresh,
                child: _body(s, showMoney),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(HistoryListState s, bool showMoney) {
    if (s.error != null && s.items.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 420),
            child: ErrorRetry(error: s.error!, onRetry: _list.load),
          ),
        ],
      );
    }
    if (!s.loaded) {
      return const Center(child: CircularProgressIndicator());
    }
    if (s.items.isEmpty && s.hasMore) {
      // "Not delivered" reads a few pages at a time and none of them had a
      // job to show: more may be further back. Not the same as nothing.
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 420),
            child: EmptyState(
              icon: Icons.manage_search_rounded,
              title: 'None found in your recent jobs',
              body: s.moreError != null
                  ? "Couldn't look further back. Try again."
                  : 'There may be more further back.',
              action: s.loadingMore ? null : 'Look further back',
              onAction: s.loadingMore
                  ? null
                  : () => _list.loadMore(retry: true),
            ),
          ),
          if (s.loadingMore)
            const Center(child: CircularProgressIndicator(strokeWidth: 2)),
        ],
      );
    }
    if (s.items.isEmpty) {
      return ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 420),
            child: EmptyState(
              icon: Icons.history_rounded,
              title: s.filter.emptyTitle,
              body: 'Finished jobs show up here.',
            ),
          ),
        ],
      );
    }
    final footer = s.loadingMore || s.moreError != null || s.hasMore;
    return ListView.separated(
      key: const Key('history-list'),
      controller: _scroll,
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      itemCount: s.items.length + (footer ? 1 : 0),
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (_, i) {
        if (i >= s.items.length) {
          if (s.moreError != null) {
            return Center(
              child: TextButton(
                key: const Key('history-more-retry'),
                onPressed: () => _list.loadMore(retry: true),
                child: const Text("Couldn't load more. Try again"),
              ),
            );
          }
          return const Padding(
            padding: EdgeInsets.all(16),
            child: Center(
              child: SizedBox(
                width: 22,
                height: 22,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          );
        }
        final item = s.items[i];
        return HistoryRow(
          item: item,
          showMoney: showMoney,
          onTap: () =>
              context.push('$historyPath/order/${item.orderId}', extra: item),
        );
      },
    );
  }
}

/// The colours of an outcome chip.
StatusChip outcomeChip(BuildContext context, HistoryOutcome o, {Key? key}) {
  final c = context.colors;
  return switch (o) {
    HistoryOutcome.delivered => StatusChip(
      o.label,
      key: key,
      fg: c.green,
      bg: c.greenSoft,
    ),
    HistoryOutcome.failed => StatusChip(
      o.label,
      key: key,
      fg: c.deal,
      bg: c.dealSoft,
    ),
    HistoryOutcome.cancelled => StatusChip(
      o.label,
      key: key,
      fg: c.muted,
      bg: c.surface2,
    ),
    HistoryOutcome.reassigned => StatusChip(
      o.label,
      key: key,
      fg: c.accentInk,
      bg: c.accentSoft,
    ),
    HistoryOutcome.other => StatusChip(
      o.label,
      key: key,
      fg: c.muted,
      bg: c.surface2,
    ),
  };
}

/// One finished job in the list.
class HistoryRow extends StatelessWidget {
  const HistoryRow({
    super.key,
    required this.item,
    required this.onTap,
    this.showMoney = true,
  });

  final HistoryItem item;
  final VoidCallback onTap;

  /// False when the rider's earnings switch is off.
  final bool showMoney;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final muted = TextStyle(color: c.muted, fontSize: 13.5, height: 1.3);
    final times = StringBuffer();
    final start = item.acceptedAt;
    if (start != null) {
      times
        ..write(istDayTime(start))
        ..write(' – ')
        ..write(istClock(item.endedAt));
    } else {
      times.write(istDayTime(item.endedAt));
    }
    final took = item.took;
    if (took != null && item.outcome == HistoryOutcome.delivered) {
      times.write(' · ${minutesText(took.inMinutes)}');
    }
    final facts = <String>[
      if (item.distanceKm != null) fmt.distance(item.distanceKm!),
    ];
    return Semantics(
      button: true,
      label: '${item.code}, ${item.outcome.label}, ${item.shop}',
      excludeSemantics: true,
      child: Material(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        child: InkWell(
          key: Key('history-row-${item.orderId}'),
          borderRadius: BorderRadius.circular(radiusBlock),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(radiusBlock),
              border: Border.all(color: c.line),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TitleWithChip(
                  title: Text(
                    item.code,
                    style: dataStyle(
                      context,
                      size: 15,
                      weight: FontWeight.w800,
                    ),
                  ),
                  chip: outcomeChip(context, item.outcome),
                ),
                const SizedBox(height: 6),
                Text(
                  item.dropArea == null
                      ? item.shop
                      : '${item.shop} → ${item.dropArea}',
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                    height: 1.3,
                  ),
                ),
                const SizedBox(height: 2),
                Text(times.toString(), style: muted),
                if (item.reason != null &&
                    item.outcome != HistoryOutcome.delivered) ...[
                  const SizedBox(height: 2),
                  Text(
                    item.reason!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: muted.copyWith(color: c.deal),
                  ),
                ],
                if (facts.isNotEmpty || (showMoney && item.hasEarning)) ...[
                  const SizedBox(height: 6),
                  // The facts on the left, the earning at the far end; they
                  // wrap rather than run off the edge with large text.
                  SizedBox(
                    width: double.infinity,
                    child: Wrap(
                      alignment: WrapAlignment.spaceBetween,
                      crossAxisAlignment: WrapCrossAlignment.end,
                      spacing: 12,
                      runSpacing: 2,
                      children: [
                        for (final f in facts)
                          Text(
                            f,
                            style: dataStyle(
                              context,
                              size: 13.5,
                              weight: FontWeight.w600,
                            ),
                          ),
                        if (showMoney && item.hasEarning)
                          Text(
                            money(item.earning!),
                            key: const Key('row-earning'),
                            style: dataStyle(
                              context,
                              size: 15,
                              weight: FontWeight.w800,
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
