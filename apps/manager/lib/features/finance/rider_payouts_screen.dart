import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/finance.dart';
import '../../state/finance.dart';
import '../../theme/app_theme.dart';
import '../../widgets/zone_picker.dart';
import 'finance_list.dart';
import 'finance_screen.dart' show FinancePeriodChips;

/// Rider payouts completed (§7 tracking 4), by the date paid, each with its
/// transaction reference.
class RiderPayoutsScreen extends ConsumerWidget {
  const RiderPayoutsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final q = ref.watch(financeQueryProvider);
    final value = ref.watch(riderPayoutsProvider(q));
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Rider payouts'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: FinancePagedList(
        value: value,
        onRetry: () => ref.invalidate(riderPayoutsProvider(q)),
        onRefresh: () => ref.read(riderPayoutsProvider(q).notifier).refresh(),
        onLoadMore: () => ref.read(riderPayoutsProvider(q).notifier).loadMore(),
        emptyText: 'No payouts in this period.',
        header: (data) => [
          const FinancePeriodChips(),
          if (data != null) TotalsLine(text: '${count(data.counts.count)} payouts · ${rupeesFlex(data.counts.payable)}'),
        ],
        itemBuilder: (context, p) => _PayoutRow(item: p),
      ),
    );
  }
}

class _PayoutRow extends StatelessWidget {
  const _PayoutRow({required this.item});
  final RiderPayoutItem item;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final p = item.payout;
    return FinanceRow(
      onTap: () => context.push('/more/riders/${item.rider.id}/ledger'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(item.rider.label, style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15))),
          Text(rupeesFlex(p.amount), style: dataStyle(context, size: 16, weight: FontWeight.w800)),
        ]),
        Text(
          [
            if (p.paidOn != null) 'Paid ${p.paidOn}',
            p.method.label,
            if (p.periodEnd != null) 'up to ${p.periodEnd}',
            if (p.requestId != null) 'approved through Approvals',
          ].join(' · '),
          style: TextStyle(fontSize: 12.5, color: c.muted),
        ),
        if (p.reference != null) ReferenceText(p.reference!, copyKey: Key('copy-payout-${p.id}')),
      ]),
    );
  }
}
