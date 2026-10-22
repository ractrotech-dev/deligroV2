import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/finance.dart';
import '../../state/finance.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import 'finance_list.dart';
import 'initiate_settlement_sheet.dart';

/// Vendor payments due (§7 tracking 1): shop by shop, oldest unpaid first.
/// "Put up for payment" opens a settlement for a different person to approve.
class VendorDuesScreen extends ConsumerStatefulWidget {
  const VendorDuesScreen({super.key});

  @override
  ConsumerState<VendorDuesScreen> createState() => _VendorDuesScreenState();
}

class _VendorDuesScreenState extends ConsumerState<VendorDuesScreen> {
  bool _delayed = false;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final args = (zoneId: ref.watch(activeZoneProvider)?.id, delayedOnly: _delayed);
    final value = ref.watch(vendorDuesProvider(args));
    final canInitiate = ref.watch(managerMeProvider).value?.can('manager.finance.initiate_payment') ?? false;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Vendor payments due'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: FinancePagedList(
        value: value,
        onRetry: () => ref.invalidate(vendorDuesProvider(args)),
        onRefresh: () => ref.read(vendorDuesProvider(args).notifier).refresh(),
        onLoadMore: () => ref.read(vendorDuesProvider(args).notifier).loadMore(),
        emptyText: _delayed ? 'No shop is overdue.' : 'No shop is owed anything.',
        header: (data) => [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
            child: Align(
              alignment: Alignment.centerLeft,
              child: FilterChip(
                key: const Key('dues-delayed-only'),
                label: const Text('Delayed only'),
                selected: _delayed,
                onSelected: (v) => setState(() => _delayed = v),
              ),
            ),
          ),
          if (data != null)
            TotalsLine(text: '${count(data.counts.count)} shops · ${rupees(data.counts.payable)} due'),
        ],
        itemBuilder: (context, d) => VendorDueRow(due: d, canInitiate: canInitiate),
      ),
    );
  }
}

class VendorDueRow extends StatelessWidget {
  const VendorDueRow({super.key, required this.due, required this.canInitiate});
  final VendorDue due;
  final bool canInitiate;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = due;
    return FinanceRow(
      onTap: () => context.push('/more/vendors/${d.vendor.id}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(d.vendor.name, style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15))),
              Text(rupees(d.payable), style: dataStyle(context, size: 16, weight: FontWeight.w800)),
            ],
          ),
          const SizedBox(height: 3),
          Text(
            [
              if (d.zone != null) d.zone!.name,
              d.cycle == 'monthly' ? 'Paid monthly' : 'Paid weekly',
              '${count(d.unsettledOrders)} unsettled orders',
              if (d.oldestUnsettledAt != null) 'oldest ${placedAt(d.oldestUnsettledAt)}',
            ].join(' · '),
            style: TextStyle(fontSize: 12.5, color: c.muted),
          ),
          if (d.lastPaidAt != null)
            Text('Last paid ${placedAt(d.lastPaidAt)}', style: TextStyle(fontSize: 12.5, color: c.muted)),
          if (d.recoverable > 0)
            Text('Shop owes Deligro ${rupees(d.recoverable)} — collect it separately',
                style: TextStyle(fontSize: 12.5, color: c.deal, fontWeight: FontWeight.w600)),
          if (d.outstandingCorrections > 0)
            Text('Correction outstanding ${rupees(d.outstandingCorrections)}',
                style: TextStyle(fontSize: 12.5, color: c.amberText)),
          const SizedBox(height: 4),
          Wrap(
            spacing: 10,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              if (d.delayed) StatusText('Delayed', color: c.amberText),
              if (d.pendingRequestId != null)
                TextButton(
                  onPressed: () => context.push('/more/approvals?id=${d.pendingRequestId}'),
                  child: const Text('Waiting for approval'),
                )
              else if (canInitiate && d.payable > 0)
                OutlinedButton(
                  key: Key('initiate-${d.vendor.id}'),
                  onPressed: () => showInitiateSettlementSheet(context, due: d),
                  child: const Text('Put up for payment'),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
