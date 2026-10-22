import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/finance.dart';
import '../../state/finance.dart';
import '../../theme/app_theme.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import 'finance_list.dart';

/// Rider payouts due (§7 tracking 3). Riders are salaried; what is due is
/// the recorded salary and adjustments not yet paid out.
class RiderDuesScreen extends ConsumerStatefulWidget {
  const RiderDuesScreen({super.key});

  @override
  ConsumerState<RiderDuesScreen> createState() => _RiderDuesScreenState();
}

class _RiderDuesScreenState extends ConsumerState<RiderDuesScreen> {
  bool _delayed = false;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final args = (zoneId: ref.watch(activeZoneProvider)?.id, delayedOnly: _delayed);
    final value = ref.watch(riderDuesProvider(args));
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Rider payouts due'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: FinancePagedList(
        value: value,
        onRetry: () => ref.invalidate(riderDuesProvider(args)),
        onRefresh: () => ref.read(riderDuesProvider(args).notifier).refresh(),
        onLoadMore: () => ref.read(riderDuesProvider(args).notifier).loadMore(),
        emptyText: _delayed ? 'No rider payout is overdue.' : 'No rider is owed anything.',
        header: (data) => [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
            child: Align(
              alignment: Alignment.centerLeft,
              child: FilterChip(
                label: const Text('Delayed only'),
                selected: _delayed,
                onSelected: (v) => setState(() => _delayed = v),
              ),
            ),
          ),
          if (data != null)
            TotalsLine(text: '${count(data.counts.count)} riders · ${rupeesFlex(data.counts.payable)} due'),
        ],
        itemBuilder: (context, d) => _RiderDueRow(due: d),
      ),
    );
  }
}

class _RiderDueRow extends StatelessWidget {
  const _RiderDueRow({required this.due});
  final RiderDue due;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = due;
    final last = d.lastPayout;
    return FinanceRow(
      onTap: () => context.push('/more/riders/${d.rider.id}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(d.rider.label, style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15))),
              Text(rupeesFlex(d.unpaid), style: dataStyle(context, size: 16, weight: FontWeight.w800)),
            ],
          ),
          const SizedBox(height: 3),
          if (d.oldestUnpaidOn != null)
            Text('Unpaid since ${d.oldestUnpaidOn}', style: TextStyle(fontSize: 12.5, color: c.muted)),
          Text(
            last == null
                ? 'Never paid out'
                : 'Last payout ${rupeesFlex(last.amount)}${last.paidOn == null ? '' : ' on ${last.paidOn}'}',
            style: TextStyle(fontSize: 12.5, color: c.muted),
          ),
          if (last?.reference != null) ReferenceText(last!.reference!, copyKey: Key('copy-rider-ref-${d.rider.id}')),
          const SizedBox(height: 4),
          Wrap(spacing: 10, crossAxisAlignment: WrapCrossAlignment.center, children: [
            if (d.delayed) StatusText('Delayed', color: c.amberText),
            if (d.pendingRequestId != null)
              TextButton(
                onPressed: () => context.push('/more/approvals?id=${d.pendingRequestId}'),
                child: const Text('Waiting for approval'),
              ),
          ]),
        ],
      ),
    );
  }
}
