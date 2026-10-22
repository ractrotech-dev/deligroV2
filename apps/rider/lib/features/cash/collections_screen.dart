import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/money.dart';
import '../../models/cash.dart';
import '../../state/cash.dart';
import '../../state/clock.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../earnings/earnings_widgets.dart'
    show RangeChips, RangeOption, StatusChip, lastDays, pickDays, thisMonth;

const _pageSize = 25;

enum _Show { all, cash, online }

final _timeFmt = DateFormat('d MMM, h:mm a');

/// "21 Oct, 7:45 PM" in IST, whatever the phone's own zone is.
String _istTime(DateTime at) =>
    _timeFmt.format(at.toUtc().add(const Duration(hours: 5, minutes: 30)));

/// Every order the rider delivered in a date range, newest first: cash they
/// collected beside the orders that were paid online (which are never cash).
class CollectionsScreen extends ConsumerStatefulWidget {
  const CollectionsScreen({super.key});

  @override
  ConsumerState<CollectionsScreen> createState() => _CollectionsScreenState();
}

class _CollectionsScreenState extends ConsumerState<CollectionsScreen> {
  late final String _today;
  late List<RangeOption> _options;
  String _selected = '31';
  late String _from;
  late String _to;
  _Show _show = _Show.all;

  final _items = <CashCollection>[];
  String? _cursor;
  bool _loading = true;
  bool _loadingMore = false;
  Object? _error;

  /// Bumped on each new range, so a slow answer for the old one is dropped.
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _today = istDayKey(ref.read(clockProvider)());
    final r31 = lastDays(_today, 31);
    final r7 = lastDays(_today, 7);
    final month = thisMonth(_today);
    _options = [
      RangeOption('7', 'Last 7 days', r7.from, r7.to),
      RangeOption('31', 'Last 31 days', r31.from, r31.to),
      RangeOption('month', 'This month', month.from, month.to),
    ];
    _from = r31.from;
    _to = r31.to;
    _load();
  }

  Future<void> _load() async {
    final gen = ++_generation;
    setState(() {
      _loading = true;
      _error = null;
      _items.clear();
      _cursor = null;
    });
    try {
      final page = await ref
          .read(cashRepoProvider)
          .collections(from: _from, to: _to, limit: _pageSize);
      if (!mounted || gen != _generation) return;
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _loading = false;
      });
    } catch (e) {
      if (!mounted || gen != _generation) return;
      setState(() {
        _error = e;
        _loading = false;
      });
    }
  }

  Future<void> _more() async {
    final cursor = _cursor;
    if (cursor == null || _loadingMore) return;
    final gen = _generation;
    setState(() => _loadingMore = true);
    try {
      final page = await ref
          .read(cashRepoProvider)
          .collections(from: _from, to: _to, cursor: cursor, limit: _pageSize);
      if (!mounted || gen != _generation) return;
      setState(() {
        _items.addAll(page.items);
        _cursor = page.nextCursor;
        _loadingMore = false;
      });
    } catch (e) {
      if (!mounted || gen != _generation) return;
      setState(() => _loadingMore = false);
      showSnack(
        context,
        e is ApiException ? e.friendly : 'Check your connection and try again.',
      );
    }
  }

  void _select(RangeOption o) {
    _selected = o.id;
    _from = o.from;
    _to = o.to;
    _load();
  }

  Future<void> _pick() async {
    final picked = await pickDays(context, today: _today, from: _from, to: _to);
    if (picked == null || !mounted) return;
    _selected = 'custom';
    _from = picked.from;
    _to = picked.to;
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final shown = _items
        .where(
          (i) => switch (_show) {
            _Show.all => true,
            _Show.cash => !i.online,
            _Show.online => i.online,
          },
        )
        .toList();
    final cashTotal = _items
        .where((i) => !i.online && !i.notRecorded)
        .fold(0, (a, i) => a + i.amount);
    return Scaffold(
      appBar: AppBar(title: const Text('Collections')),
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          children: [
            RangeChips(
              options: _options,
              selected: _selected,
              onSelect: _select,
              onPickDates: _pick,
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              children: [
                for (final s in _Show.values)
                  ChoiceChip(
                    key: Key('show-${s.name}'),
                    label: Text(switch (s) {
                      _Show.all => 'All orders',
                      _Show.cash => 'Cash',
                      _Show.online => 'Paid online',
                    }),
                    selected: _show == s,
                    onSelected: (_) => setState(() => _show = s),
                  ),
              ],
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(2, 12, 2, 12),
              child: Text(
                '${formatRange(_from, _to)} · cash collected ${money(cashTotal)}',
                key: const Key('collections-range'),
                style: TextStyle(
                  color: c.muted,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error != null)
              ErrorRetry(error: _error!, onRetry: _load)
            else if (shown.isEmpty)
              const SizedBox(
                height: 320,
                child: EmptyState(
                  icon: Icons.receipt_long_outlined,
                  title: 'No orders here',
                  body: 'Orders you deliver in these days show up here.',
                ),
              )
            else ...[
              for (final item in shown) ...[
                _CollectionRow(item: item),
                const SizedBox(height: 10),
              ],
              if (_cursor != null)
                Center(
                  child: _loadingMore
                      ? const Padding(
                          padding: EdgeInsets.all(12),
                          child: CircularProgressIndicator(),
                        )
                      : TextButton(
                          key: const Key('collections-more'),
                          onPressed: _more,
                          child: const Text('Load more'),
                        ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _CollectionRow extends StatelessWidget {
  const _CollectionRow({required this.item});

  final CashCollection item;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final chip = item.online
        ? StatusChip('Paid online', fg: c.blue, bg: c.surface2)
        : item.notRecorded
        ? StatusChip('Not recorded', fg: c.deal, bg: c.dealSoft)
        : StatusChip('Cash collected', fg: c.green, bg: c.greenSoft);
    return Panel(
      key: Key('collection-${item.orderId}'),
      padding: const EdgeInsets.all(14),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  item.code,
                  style: dataStyle(context, size: 15, weight: FontWeight.w700),
                ),
                const SizedBox(height: 2),
                Text(
                  _istTime(item.at),
                  style: TextStyle(color: c.muted, fontSize: 13),
                ),
                const SizedBox(height: 8),
                Align(alignment: Alignment.centerLeft, child: chip),
              ],
            ),
          ),
          const SizedBox(width: 12),
          // An online order shows its total in grey: it was never cash.
          Text(
            item.notRecorded ? '—' : money(item.amount),
            style: dataStyle(context, size: 18, weight: FontWeight.w800)
                .copyWith(color: item.online || item.notRecorded ? c.muted : c.ink),
          ),
        ],
      ),
    );
  }
}
