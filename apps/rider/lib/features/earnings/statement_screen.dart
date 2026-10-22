import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/money.dart';
import '../../core/statement_export.dart';
import '../../models/earnings.dart';
import '../../state/clock.dart';
import '../../state/earnings.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/rows.dart';
import 'earnings_widgets.dart';

/// A date-wise statement: opening pending + earned − paid = closing pending,
/// and every record in the range, with the rider's name and ID on top. It can
/// be saved as a PDF or shared as a CSV, both carrying the same header.
class StatementScreen extends ConsumerStatefulWidget {
  const StatementScreen({super.key});

  @override
  ConsumerState<StatementScreen> createState() => _StatementScreenState();
}

class _StatementScreenState extends ConsumerState<StatementScreen> {
  late final String _today;
  late List<RangeOption> _options;
  String _selected = 'month';
  late String _from;
  late String _to;

  Statement? _statement;
  bool _loading = true;
  Object? _error;
  bool _makingPdf = false;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _today = istDayKey(ref.read(clockProvider)());
    final week = lastDays(_today, 7);
    final month = thisMonth(_today);
    final previous = lastMonth(_today);
    _options = [
      RangeOption('7', 'Last 7 days', week.from, week.to),
      RangeOption('month', 'This month', month.from, month.to),
      RangeOption('last-month', 'Last month', previous.from, previous.to),
    ];
    _from = month.from;
    _to = month.to;
    _load();
  }

  Future<void> _load() async {
    final gen = ++_generation;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final s = await ref.read(earningsRepoProvider).statement(_from, _to);
      if (!mounted || gen != _generation) return;
      setState(() {
        _statement = s;
        _loading = false;
      });
    } catch (e) {
      if (!mounted || gen != _generation) return;
      setState(() {
        _error = e;
        _statement = null;
        _loading = false;
      });
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

  /// The statement with the rider's name and ID filled in from the profile if
  /// the server left them out, so a file never goes out without them.
  Statement _withIdentity(Statement s) {
    final me = ref.read(meProvider).value;
    // Also leaves the ₹0 delivery rows out of the screen and both files.
    return Statement(
      riderCode: s.riderCode ?? me?.riderCode,
      name: s.name ?? me?.name,
      from: s.from,
      to: s.to,
      openingPending: s.openingPending,
      earned: s.earned,
      paid: s.paid,
      closingPending: s.closingPending,
      rows: s.lines,
    );
  }

  Future<void> _savePdf(Statement s) async {
    if (_makingPdf) return;
    setState(() => _makingPdf = true);
    try {
      final full = _withIdentity(s);
      final bytes = await statementPdf(full);
      await ref
          .read(statementSharerProvider)
          .sharePdf(bytes, statementFileName(full, 'pdf'));
    } catch (_) {
      if (mounted) {
        showSnack(context, "Couldn't create the PDF. Please try again.");
      }
    } finally {
      if (mounted) setState(() => _makingPdf = false);
    }
  }

  Future<void> _shareCsv(Statement s) async {
    try {
      final full = _withIdentity(s);
      await ref
          .read(statementSharerProvider)
          .shareCsv(statementCsv(full), statementFileName(full, 'csv'));
    } catch (_) {
      if (mounted) {
        showSnack(context, "Couldn't share the CSV. Please try again.");
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = _statement;
    return Scaffold(
      appBar: AppBar(title: const Text('Statement')),
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
            const SizedBox(height: 14),
            if (_loading && s == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_error != null)
              ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 320),
                child: ErrorRetry(error: _error!, onRetry: _load),
              )
            else if (s != null)
              _StatementBody(
                statement: _withIdentity(s),
                busy: _loading,
                makingPdf: _makingPdf,
                onPdf: () => _savePdf(s),
                onCsv: () => _shareCsv(s),
              ),
          ],
        ),
      ),
    );
  }
}

class _StatementBody extends StatelessWidget {
  const _StatementBody({
    required this.statement,
    required this.busy,
    required this.makingPdf,
    required this.onPdf,
    required this.onCsv,
  });

  final Statement statement;
  final bool busy;
  final bool makingPdf;
  final VoidCallback onPdf;
  final VoidCallback onCsv;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = statement;
    final name = (s.name ?? '').trim();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Panel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (name.isNotEmpty)
                Text(name, style: Theme.of(context).textTheme.titleMedium),
              if (s.riderCode != null)
                Text(
                  'Rider ID ${s.riderCode}',
                  style: dataStyle(context, size: 14, weight: FontWeight.w600),
                ),
              const SizedBox(height: 4),
              Text(
                formatRange(s.from, s.to),
                key: const Key('statement-range'),
                style: TextStyle(
                  color: c.muted,
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: MoneyTile(
                key: const Key('stmt-opening'),
                label: 'Pending at start',
                value: money(s.openingPending),
                valueColor: s.openingPending < 0 ? c.deal : null,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: MoneyTile(
                key: const Key('stmt-earned'),
                label: 'Earned',
                value: money(s.earned),
                valueColor: s.earned < 0 ? c.deal : null,
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: MoneyTile(
                key: const Key('stmt-paid'),
                label: 'Paid',
                value: money(s.paid),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: MoneyTile(
                key: const Key('stmt-closing'),
                label: 'Pending at end',
                value: money(s.closingPending),
                valueColor: s.closingPending < 0 ? c.deal : null,
              ),
            ),
          ],
        ),
        if (s.closingPending < 0)
          Padding(
            padding: const EdgeInsets.only(top: 8, left: 2, right: 2),
            child: Text(
              'You owe Deligro this — it comes off your next payout',
              style: TextStyle(color: c.deal, fontSize: 13, height: 1.3),
            ),
          ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: FilledButton.icon(
                key: const Key('statement-pdf'),
                onPressed: busy || makingPdf ? null : onPdf,
                icon: makingPdf
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2.5),
                      )
                    : const Icon(Icons.picture_as_pdf_outlined),
                label: const Text('Save PDF'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: OutlinedButton.icon(
                key: const Key('statement-csv'),
                onPressed: busy ? null : onCsv,
                icon: const Icon(Icons.ios_share_rounded),
                label: const Text('Share CSV'),
              ),
            ),
          ],
        ),
        const RowsLabel('Records'),
        if (s.rows.isEmpty)
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 220),
            child: const EmptyState(
              icon: Icons.receipt_long_outlined,
              title: 'No records in this range',
              body: 'Try a longer range.',
            ),
          )
        else
          RowsCard(
            children: [
              for (final r in s.rows)
                RecordRow(
                  key: Key('record-${r.id}'),
                  record: r,
                  onTap: () => context.push('$earningsPath/record', extra: r),
                ),
            ],
          ),
      ],
    );
  }
}
