import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../state/orders.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';
import 'order_card.dart';

/// Past orders: completed or cancelled, by period, with search.
class HistoryView extends ConsumerStatefulWidget {
  const HistoryView({super.key, this.initialKind});

  /// `cancelled` opens the cancelled list.
  final String? initialKind;

  @override
  ConsumerState<HistoryView> createState() => _HistoryViewState();
}

class _HistoryViewState extends ConsumerState<HistoryView> {
  late String _kind = widget.initialKind == 'cancelled' ? 'cancelled' : 'completed';
  String _range = 'all';
  DateTime? _date;
  String _search = '';
  final _searchCtl = TextEditingController();
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    _searchCtl.dispose();
    super.dispose();
  }

  ArchiveQuery get _query =>
      (kind: _kind, range: _range, date: _range == 'date' && _date != null ? isoDate(_date!) : null, search: _search);

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: _date ?? now,
      firstDate: DateTime(now.year - 3),
      lastDate: now,
    );
    if (picked != null) {
      setState(() {
        _date = picked;
        _range = 'date';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final result = ref.watch(archiveProvider(_query));

    Widget rangeChip(String value, String label, {VoidCallback? onTap}) => Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        label: Text(label),
        selected: _range == value,
        showCheckmark: false,
        onSelected: (_) => onTap != null ? onTap() : setState(() => _range = value),
      ),
    );

    return RefreshIndicator(
      onRefresh: () async => ref.invalidate(archiveProvider(_query)),
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: SegmentedButton<String>(
                segments: [
                  ButtonSegment(value: 'completed', label: Text('Completed')),
                  ButtonSegment(value: 'cancelled', label: Text('Cancelled')),
                ],
                selected: {_kind},
                showSelectedIcon: false,
                onSelectionChanged: (s) => setState(() => _kind = s.first),
              ),
            ),
          ),
          SliverToBoxAdapter(
            child: SizedBox(
              height: 52,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.fromLTRB(16, 8, 8, 4),
                children: [
                  rangeChip('all', 'All'),
                  rangeChip('this_month', 'This month'),
                  rangeChip('previous_month', 'Last month'),
                  rangeChip(
                    'date',
                    _range == 'date' && _date != null ? DateFormat('d MMM y', 'en_IN').format(_date!) : 'Pick a date',
                    onTap: _pickDate,
                  ),
                ],
              ),
            ),
          ),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
              child: TextField(
                controller: _searchCtl,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  isDense: true,
                  hintText: 'Search order ID, customer or dish',
                  prefixIcon: const Icon(Icons.search_rounded),
                ),
                onChanged: (v) {
                  _debounce?.cancel();
                  _debounce = Timer(const Duration(milliseconds: 400), () => setState(() => _search = v.trim()));
                },
              ),
            ),
          ),
          ...result.when(
            loading: () => [const SliverFillRemaining(child: Center(child: CircularProgressIndicator()))],
            error: (e, _) => [
              SliverFillRemaining(
                hasScrollBody: false,
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Text(
                      e is ApiException ? e.friendly() : 'Couldn\'t load past orders.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: c.muted),
                    ),
                  ),
                ),
              ),
            ],
            data: (r) => r.orders.isEmpty
                ? [
                    SliverFillRemaining(
                      hasScrollBody: false,
                      child: Center(
                        child: Text(
                          _kind == 'cancelled'
                              ? 'No cancelled orders in this period.'
                              : 'No completed orders in this period.',
                          style: TextStyle(color: c.muted),
                        ),
                      ),
                    ),
                  ]
                : [
                    SliverToBoxAdapter(
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(20, 4, 20, 4),
                        child: Text(
                          '${r.total} orders',
                          style: TextStyle(color: c.muted, fontWeight: FontWeight.w700, fontSize: 12.5),
                        ),
                      ),
                    ),
                    SliverList.builder(
                      itemCount: r.orders.length,
                      itemBuilder: (_, i) => OrderCard(order: r.orders[i]),
                    ),
                    if (r.orders.length < r.total)
                      SliverToBoxAdapter(
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                          child: OutlinedButton(
                            onPressed: () =>
                                runWrite(context, ref, () => ref.read(archiveProvider(_query).notifier).loadMore()),
                            child: Text('Show more (${r.total - r.orders.length} older)'),
                          ),
                        ),
                      ),
                  ],
          ),
          const SliverToBoxAdapter(child: SizedBox(height: 24)),
        ],
      ),
    );
  }
}
