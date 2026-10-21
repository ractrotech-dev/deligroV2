import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../models/rider.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../orders/order_labels.dart' show StatusText;
import '../vendors/vendor_tabs.dart' show Figure, InfoSection;

/// One page of a rider's ledger for a status filter.
final _ledgerProvider = FutureProvider.autoDispose.family<LedgerPage, (String, LedgerStatus?)>(
  (ref, key) {
    ref.watch(signedInProvider);
    return ref.read(ridersRepoProvider).ledger(key.$1, status: key.$2);
  },
  retry: (_, _) => null,
);

/// A rider's ledger (§5.13, `manager.finance.view`): salary, bonuses,
/// deductions and adjustments with who added them and whether they were
/// paid, and the payouts with their references.
class RiderLedgerScreen extends ConsumerStatefulWidget {
  const RiderLedgerScreen({super.key, required this.riderId});
  final String riderId;

  @override
  ConsumerState<RiderLedgerScreen> createState() => _RiderLedgerScreenState();
}

class _RiderLedgerScreenState extends ConsumerState<RiderLedgerScreen> {
  LedgerStatus? _status;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final key = (widget.riderId, _status);
    Widget chip(String k, String label, LedgerStatus? s) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            key: Key('ledger-filter-$k'),
            label: Text(label),
            selected: _status == s,
            onSelected: (_) => setState(() => _status = s),
          ),
        );
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Ledger'), backgroundColor: c.bg),
      body: AsyncView(
        value: ref.watch(_ledgerProvider(key)),
        onRetry: () => ref.invalidate(_ledgerProvider(key)),
        builder: (page) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(_ledgerProvider(key)),
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            children: [
              Wrap(
                spacing: 28,
                runSpacing: 12,
                children: [
                  Figure(rupeesPaise(page.summary.pending), 'Owed, not yet paid'),
                  Figure(rupeesPaise(page.summary.paid), 'Paid'),
                ],
              ),
              const SizedBox(height: 12),
              Row(children: [chip('all', 'All', null), chip('pending', 'Pending', LedgerStatus.pending), chip('paid', 'Paid', LedgerStatus.paid)]),
              InfoSection(
                title: 'Entries',
                children: page.items.isEmpty
                    ? const [EmptyLine('No entries.')]
                    : [for (final r in page.items) _LedgerRowView(row: r)],
              ),
              InfoSection(
                title: 'Payouts',
                children: page.payouts.isEmpty
                    ? [Text('No payouts yet.', style: TextStyle(color: c.muted))]
                    : [
                        for (final p in page.payouts)
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 8),
                            child: Row(
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(rupeesPaise(p.amount), style: dataStyle(context, size: 14, weight: FontWeight.w700)),
                                      Text(
                                        [
                                          if (p.paidOn != null) 'Paid ${p.paidOn}',
                                          p.method.label,
                                          if (p.reference != null) 'Ref ${p.reference}',
                                          '${p.items} ${p.items == 1 ? 'entry' : 'entries'}',
                                        ].join(' · '),
                                        style: TextStyle(fontSize: 12.5, color: c.muted),
                                      ),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ),
                      ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _LedgerRowView extends StatelessWidget {
  const _LedgerRowView({required this.row});
  final LedgerRow row;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = row;
    // A deduction is stored as a positive amount and subtracted.
    final signed = r.type == LedgerType.deduction ? -r.amount.abs() : r.amount;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(r.type.label, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
                if (r.reason != null) Text(r.reason!, style: TextStyle(fontSize: 13, color: c.ink)),
                Text(
                  [?r.date, ?r.orderCode, if (r.createdBy != null) 'by ${r.createdBy!.name}'].join(' · '),
                  style: TextStyle(fontSize: 12.5, color: c.muted),
                ),
              ],
            ),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                rupeesPaise(signed),
                style: dataStyle(context, size: 14, weight: FontWeight.w700).copyWith(color: signed < 0 ? c.deal : c.ink),
              ),
              StatusText(r.status.label, color: r.status == LedgerStatus.paid ? c.green : c.amberText, size: 12),
            ],
          ),
        ],
      ),
    );
  }
}
