import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/orders.dart' show TicketPriority;
import '../../models/support_ops.dart';
import '../../models/tickets.dart';
import '../../state/session.dart';
import '../../state/support.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/polling.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import 'ticket_filters_sheet.dart';
import 'ticket_labels.dart';
import 'ticket_thread_screen.dart';

const supportWideBreakpoint = 840.0;

/// Support (§11): every vendor, rider and customer ticket in this manager's
/// zones — by queue (active, escalated, unassigned, mine, resolved, closed),
/// filtered, searchable by number or subject, paged as the manager scrolls.
/// On a tablet the ticket opens beside the queue.
class SupportQueueScreen extends ConsumerStatefulWidget {
  const SupportQueueScreen({super.key, this.query});

  /// The route's URI: links from metrics open it already filtered
  /// (`/more/support?category=payment`).
  final Uri? query;

  @override
  ConsumerState<SupportQueueScreen> createState() => _SupportQueueScreenState();
}

class _SupportQueueScreenState extends ConsumerState<SupportQueueScreen> {
  late TicketFilters _filters;
  late final TextEditingController _search;
  final _scroll = ScrollController();
  Timer? _debounce;
  TicketCounts _counts = const TicketCounts();
  TicketFilters? _effective;
  bool _wide = false;
  String? _selected;

  @override
  void initState() {
    super.initState();
    final q = widget.query?.queryParameters ?? const {};
    _filters = q.isEmpty ? const TicketFilters() : TicketFilters.fromQuery(q);
    _search = TextEditingController(text: _filters.q ?? '');
    _scroll.addListener(_onScroll);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _set(TicketFilters f) {
    if (f == _filters) return;
    setState(() => _filters = f);
    if (_scroll.hasClients) _scroll.jumpTo(0);
  }

  void _onSearch(String text) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () {
      final q = text.trim().replaceFirst('#', '');
      _set(_filters.copyWith(q: q.length < 3 && int.tryParse(q) == null ? null : (q.isEmpty ? null : q)));
    });
  }

  void _onScroll() {
    final eff = _effective;
    if (eff == null || !_scroll.hasClients) return;
    final p = _scroll.position;
    if (p.maxScrollExtent > 0 && p.pixels >= p.maxScrollExtent * 0.8) {
      ref.read(ticketListProvider(eff).notifier).loadMore();
    }
  }

  void _open(TicketListItem t) {
    if (_wide) {
      setState(() => _selected = t.id);
      return;
    }
    GoRouter.maybeOf(context)?.push('/more/tickets/${t.id}');
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final zone = ref.watch(activeZoneProvider);
    final eff = _filters.zoneId != null || zone == null ? _filters : _filters.copyWith(zoneId: zone.id);
    _effective = eff;
    final value = ref.watch(ticketListProvider(eff));
    final data = value.value;
    if (data != null) _counts = data.counts;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Support'),
        backgroundColor: c.bg,
        actions: [
          IconButton(
            key: const Key('support-metrics'),
            tooltip: 'Response times and recurring problems',
            onPressed: () => GoRouter.maybeOf(context)?.push('/more/support/metrics'),
            icon: const Icon(Icons.insights_outlined),
          ),
          const Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip()),
        ],
      ),
      body: (me?.hasNoZones ?? false)
          ? const Padding(padding: EdgeInsets.all(16), child: NoZonesNotice())
          : Polling(
              interval: supportQueueRefresh,
              onTick: () => ref.read(ticketListProvider(eff).notifier).refresh(),
              child: LayoutBuilder(
                builder: (context, box) {
                  _wide = box.maxWidth >= supportWideBreakpoint;
                  final list = Column(
                    children: [
                      _searchRow(c, data?.items ?? const []),
                      _queues(),
                      if (_filters.narrowed) _activeFilters(),
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
                            ? Center(child: Text('Pick a ticket to see it here.', style: TextStyle(color: c.muted)))
                            : TicketThreadScreen(key: ValueKey(_selected), ticketId: _selected!),
                      ),
                    ],
                  );
                },
              ),
            ),
    );
  }

  Widget _searchRow(AppColors c, List<TicketListItem> loaded) {
    final categories = {for (final t in loaded) if (t.summary.category.isNotEmpty) t.summary.category}.toList();
    final n = _filters.sheetCount;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              key: const Key('tickets-search'),
              controller: _search,
              onChanged: _onSearch,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                isDense: true,
                prefixIcon: const Icon(Icons.search),
                hintText: 'Ticket number or subject',
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
          ),
          const SizedBox(width: 8),
          Badge(
            isLabelVisible: n > 0,
            label: Text('$n'),
            backgroundColor: c.accent,
            textColor: c.onAccent,
            child: IconButton.outlined(
              key: const Key('tickets-filters'),
              tooltip: 'Filters',
              onPressed: () async {
                final next = await showTicketFiltersSheet(context, current: _filters, categories: categories);
                if (next != null && mounted) _set(next);
              },
              icon: const Icon(Icons.tune),
            ),
          ),
        ],
      ),
    );
  }

  Widget _queues() {
    final current = _filters.queue;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
      child: Row(
        children: [
          for (final q in TicketQueue.values)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ChoiceChip(
                key: Key('ticket-queue-${q.name}'),
                label: Text('${q.label} (${_counts.of(q)})'),
                selected: current == q,
                onSelected: (_) => _set(TicketFilters.forQueue(q, _filters)),
              ),
            ),
        ],
      ),
    );
  }

  Widget _activeFilters() {
    final f = _filters;
    Widget chip(String key, String label, TicketFilters cleared) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: InputChip(
            key: Key('tickets-active-$key'),
            label: Text(label),
            onDeleted: () => _set(cleared),
            deleteButtonTooltipMessage: 'Remove',
          ),
        );
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
      child: Row(children: [
        if (f.category != null) chip('category', categoryLabel(f.category!), f.copyWith(category: null)),
        if (f.priorities.isNotEmpty)
          chip('priority', f.priorities.map((p) => priorityLabel(TicketPriority.parse(p))).join(', '),
              f.copyWith(priorities: const {})),
        if (f.requesterRoles.isNotEmpty)
          chip('role', 'From ${f.requesterRoles.map((r) => RequesterRole.parse(r).label.toLowerCase()).join(', ')}',
              f.copyWith(requesterRoles: const {})),
        if (f.team != null) chip('team', f.team!.label, f.copyWith(team: null)),
        if (f.vendorId != null) chip('vendor', 'One vendor', f.copyWith(vendorId: null)),
        if (f.riderId != null) chip('rider', 'One rider', f.copyWith(riderId: null)),
        if (f.from != null || f.to != null) chip('dates', 'Date range', f.copyWith(from: null, to: null)),
      ]),
    );
  }

  Widget _list(AsyncValue<TicketList> value, TicketFilters eff) {
    final data = value.value;
    if (data == null) {
      if (value.hasError) {
        final e = value.error!;
        if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
        return ErrorRetry(error: e, onRetry: () => ref.invalidate(ticketListProvider(eff)));
      }
      return const Center(child: CircularProgressIndicator());
    }

    Future<void> pull() => ref.read(ticketListProvider(eff).notifier).refresh();

    if (data.items.isEmpty) {
      return RefreshIndicator(
        onRefresh: pull,
        child: ListView(
          key: const Key('tickets-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            if (_filters.narrowed)
              const EmptyLine('No tickets match these filters.')
            else
              const EmptyLine('Nothing in this queue.'),
          ],
        ),
      );
    }

    final footer = data.hasMore || data.loadingMore || data.loadMoreFailed;
    return RefreshIndicator(
      onRefresh: pull,
      child: ListView.separated(
        key: const Key('tickets-list'),
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
        itemCount: data.items.length + (footer ? 1 : 0),
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          if (i == data.items.length) {
            if (data.loadMoreFailed) {
              return Center(
                child: TextButton(
                  onPressed: () => ref.read(ticketListProvider(eff).notifier).loadMore(),
                  child: const Text("Couldn't load more — tap to retry"),
                ),
              );
            }
            // A first page too short to scroll still pulls in the next one.
            if (!data.loadingMore) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (mounted) ref.read(ticketListProvider(eff).notifier).loadMore();
              });
            }
            return const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4))),
            );
          }
          final t = data.items[i];
          return SupportTicketTile(ticket: t, selected: _wide && t.id == _selected, onTap: () => _open(t));
        },
      ),
    );
  }
}

IconData _roleIcon(RequesterRole r) => switch (r) {
      RequesterRole.restaurant => Icons.storefront_outlined,
      RequesterRole.driver => Icons.two_wheeler_outlined,
      RequesterRole.customer => Icons.person_outline,
      _ => Icons.badge_outlined,
    };

/// One ticket in the queue: number, status, priority, level, subject, who
/// raised it, who has it, and how long it has been open.
class SupportTicketTile extends StatelessWidget {
  const SupportTicketTile({super.key, required this.ticket, required this.onTap, this.selected = false});
  final TicketListItem ticket;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final t = ticket;
    final s = t.summary;
    final mark = switch (s.priority) {
      TicketPriority.emergency => c.deal,
      TicketPriority.high => c.amberText,
      TicketPriority.normal => null,
    };
    final small = TextStyle(color: c.muted, fontSize: 12.5);
    return Material(
      color: selected ? c.accentSoft : c.surface,
      borderRadius: BorderRadius.circular(radiusBlock),
      child: InkWell(
        key: Key('support-ticket-${t.id}'),
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(radiusBlock),
            border: Border.all(color: s.priority == TicketPriority.emergency ? c.deal.withValues(alpha: 0.5) : c.line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('#${s.number}', style: dataStyle(context, size: 13, weight: FontWeight.w700)),
                  const SizedBox(width: 8),
                  Flexible(child: StatusText(s.status.displayLabel, color: ticketStatusColor(c, s.status))),
                  const Spacer(),
                  if (t.escalationLevel > 0) ...[
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                      decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(6)),
                      child: Text('Level ${t.escalationLevel}',
                          style: TextStyle(color: c.deal, fontSize: 11.5, fontWeight: FontWeight.w700)),
                    ),
                    const SizedBox(width: 6),
                  ],
                  if (mark != null)
                    Text(priorityLabel(s.priority), style: TextStyle(color: mark, fontSize: 12, fontWeight: FontWeight.w700)),
                ],
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  if (t.unreadForStaff > 0) ...[
                    Container(width: 8, height: 8, decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle)),
                    const SizedBox(width: 6),
                  ],
                  Expanded(
                    child: Text(s.subject,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontWeight: t.unreadForStaff > 0 ? FontWeight.w800 : FontWeight.w600, color: c.ink)),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Row(
                children: [
                  Icon(_roleIcon(s.requesterRole), size: 15, color: c.muted),
                  const SizedBox(width: 4),
                  Flexible(
                    child: Text(
                      [t.requester?.name ?? s.requesterRole.label, categoryLabel(s.category)].join(' · '),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: small,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Icon(Icons.person_pin_outlined, size: 15, color: t.assignee == null ? c.amberText : c.muted),
                  const SizedBox(width: 3),
                  Text(t.assignee?.name ?? 'Unassigned',
                      style: TextStyle(color: t.assignee == null ? c.amberText : c.muted, fontSize: 12.5)),
                  const SizedBox(width: 8),
                  Icon(Icons.schedule, size: 14, color: t.awaitingFirstResponse ? c.deal : c.muted),
                  const SizedBox(width: 3),
                  Text(minutesLabel(t.ageMinutes.toDouble()),
                      style: dataStyle(context, size: 12).copyWith(color: t.awaitingFirstResponse ? c.deal : c.muted)),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
