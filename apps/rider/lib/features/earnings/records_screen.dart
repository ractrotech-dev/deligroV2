import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/money.dart';
import '../../models/earnings.dart';
import '../../state/clock.dart';
import '../../state/earnings.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/rows.dart';
import 'earnings_widgets.dart';

/// Records per request (the server allows up to 100).
const _pageSize = 25;

/// Every delivery, incentive, bonus, adjustment and deduction in a date range,
/// newest first. The last 31 days to begin with.
class RecordsScreen extends ConsumerStatefulWidget {
  const RecordsScreen({super.key});

  @override
  ConsumerState<RecordsScreen> createState() => _RecordsScreenState();
}

class _RecordsScreenState extends ConsumerState<RecordsScreen> {
  late final String _today;
  late List<RangeOption> _options;
  String _selected = '31';
  late String _from;
  late String _to;

  final _items = <EarningRecord>[];
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
          .read(earningsRepoProvider)
          .records(from: _from, to: _to, limit: _pageSize);
      if (!mounted || gen != _generation) return;
      setState(() {
        _items.addAll(page.items.where((r) => r.isMoneyLine));
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
          .read(earningsRepoProvider)
          .records(from: _from, to: _to, cursor: cursor, limit: _pageSize);
      if (!mounted || gen != _generation) return;
      setState(() {
        _items.addAll(page.items.where((r) => r.isMoneyLine));
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
    return Scaffold(
      appBar: AppBar(title: const Text('Records')),
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
            Padding(
              padding: const EdgeInsets.fromLTRB(2, 12, 2, 12),
              child: Text(
                formatRange(_from, _to),
                key: const Key('records-range'),
                style: TextStyle(
                  color: c.muted,
                  fontWeight: FontWeight.w700,
                  fontSize: 13,
                ),
              ),
            ),
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error != null)
              ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 320),
                child: ErrorRetry(error: _error!, onRetry: _load),
              )
            else if (_items.isEmpty)
              ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 320),
                child: const EmptyState(
                  icon: Icons.receipt_long_outlined,
                  title: 'No records in this range',
                  body: 'Try a longer range.',
                ),
              )
            else ...[
              RowsCard(
                children: [
                  for (final r in _items)
                    RecordRow(
                      key: Key('record-${r.id}'),
                      record: r,
                      onTap: () =>
                          context.push('$earningsPath/record', extra: r),
                    ),
                ],
              ),
              if (_cursor != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: OutlinedButton(
                    key: const Key('records-more'),
                    onPressed: _loadingMore ? null : _more,
                    child: _loadingMore
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2.5),
                          )
                        : const Text('Show older records'),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}
