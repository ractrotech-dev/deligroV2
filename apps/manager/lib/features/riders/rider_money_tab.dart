import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/payment_request.dart';
import '../../models/rider.dart';
import '../../state/riders.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../cash/deposit_card.dart';
import '../payments/payout_request_sheet.dart';
import '../orders/order_labels.dart' show StatusText;
import '../vendors/vendor_tabs.dart' show FactRow, Figure, InfoSection;
import 'rider_actions.dart';

Widget _scroll(List<Widget> children) => ListView(padding: const EdgeInsets.fromLTRB(16, 4, 16, 32), children: children);

/// Opens the salary payout request form for [rider] (Approvals, Task A5).
/// Set by the payments feature so this tab doesn't depend on it directly.
typedef PayoutRequestOpener = Future<void> Function(BuildContext context, WidgetRef ref, RiderDetail rider);

/// §5.13 (only with `manager.finance.view`): what the rider is owed and has
/// been paid, the last payout, requests waiting for approval, the ledger,
/// and — with the right permissions — recording a salary payout or a bonus /
/// deduction. Riders are salaried: nothing here computes per-order pay.
class RiderMoneyTab extends ConsumerWidget {
  const RiderMoneyTab({super.key, required this.rider, required this.money, this.requestPayout});
  final RiderDetail rider;
  final RiderMoney money;
  final PayoutRequestOpener? requestPayout;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final m = money;
    final last = m.lastPayout;
    final open = requestPayout ?? showPayoutRequestSheet;
    return _scroll([
      const SizedBox(height: 12),
      Wrap(
        spacing: 28,
        runSpacing: 12,
        children: [
          Figure(rupeesPaise(m.pending), 'Owed, not yet paid'),
          Figure(rupeesPaise(m.paidTotal), 'Paid so far'),
        ],
      ),
      const SizedBox(height: 12),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          if (rider.allowed.requestPayout)
            FilledButton.icon(
              key: const Key('rider-request-payout'),
              onPressed: () => open(context, ref, rider),
              icon: const Icon(Icons.payments_outlined, size: 18),
              label: const Text('Record salary payout'),
            ),
          if (rider.allowed.addAdjustment)
            OutlinedButton.icon(
              key: const Key('rider-add-adjustment'),
              onPressed: () => addRiderAdjustment(context, ref, rider),
              icon: const Icon(Icons.add_card_outlined, size: 18),
              label: const Text('Add bonus / deduction'),
            ),
          TextButton(
            key: const Key('rider-open-ledger'),
            onPressed: () => GoRouter.maybeOf(context)?.push('/more/riders/${rider.id}/ledger'),
            child: const Text('Open the ledger'),
          ),
        ],
      ),
      InfoSection(
        title: 'Last payout',
        children: last == null
            ? [Text('No payouts yet.', style: TextStyle(color: c.muted))]
            : [
                FactRow('Amount', rupeesPaise(last.amount), mono: true),
                FactRow('Paid on', last.paidOn ?? '—', mono: true),
                if (last.periodEnd != null) FactRow('For the period to', last.periodEnd!, mono: true),
                FactRow('Method', last.method.label),
                if (last.reference != null) FactRow('Reference', last.reference!, mono: true),
              ],
      ),
      InfoSection(
        title: 'Waiting for approval',
        children: m.pendingRequests.isEmpty
            ? [Text('Nothing waiting.', style: TextStyle(color: c.muted))]
            : [for (final r in m.pendingRequests) _RequestRow(request: r)],
      ),
    ]);
  }
}

class _RequestRow extends StatelessWidget {
  const _RequestRow({required this.request});
  final PaymentRequest request;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = request;
    return InkWell(
      onTap: () => GoRouter.maybeOf(context)?.push('/more/approvals?id=${r.id}'),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(rupeesPaise(r.amount), style: dataStyle(context, size: 14, weight: FontWeight.w700)),
                  Text(
                    ['Asked by ${r.requestedBy?.name ?? 'someone'}', placedAt(r.requestedAt)].join(' · '),
                    style: TextStyle(fontSize: 12.5, color: c.muted),
                  ),
                ],
              ),
            ),
            StatusText(r.status.label, color: c.amberText),
          ],
        ),
      ),
    );
  }
}

/// §5.14: cash collected and deposited today, deposits waiting for a
/// manager, and open disputes about a day's count.
class RiderCashTab extends ConsumerWidget {
  const RiderCashTab({super.key, required this.rider});
  final RiderDetail rider;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final cash = rider.cash;
    void reload() => ref.read(riderDetailProvider(rider.id).notifier).refresh();
    return _scroll([
      const SizedBox(height: 12),
      Wrap(
        spacing: 28,
        runSpacing: 12,
        children: [
          Figure(rupees(cash.collectedToday), 'Collected today'),
          Figure(rupees(cash.depositedToday), 'Deposited today'),
          Figure(rupees(cash.pendingDeposit), 'Still with the rider'),
        ],
      ),
      InfoSection(
        title: 'Deposits waiting',
        children: cash.openDeposits.isEmpty
            ? [Text('No deposits waiting.', style: TextStyle(color: c.muted))]
            : [
                for (final d in cash.openDeposits)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: DepositCard(deposit: d, showRider: false, onChanged: reload),
                  ),
              ],
      ),
      InfoSection(
        title: 'Open disputes',
        children: cash.openDisputes.isEmpty
            ? [Text('No open disputes.', style: TextStyle(color: c.muted))]
            : [
                for (final d in cash.openDisputes)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: DisputeCard(dispute: d, showRider: false, onChanged: reload),
                  ),
              ],
      ),
      if (cash.openDeposits.isEmpty && cash.openDisputes.isEmpty && cash.collectedToday == 0)
        const EmptyLine('No cash moved today.'),
    ]);
  }
}
