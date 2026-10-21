import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/money.dart';
import '../../state/money.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

/// Payments & settlements (requirements §4): what Deligro owes the shop now,
/// what it has paid, every settlement with its statement, and the orders not
/// yet paid out.
class PaymentsScreen extends ConsumerStatefulWidget {
  const PaymentsScreen({super.key});

  @override
  ConsumerState<PaymentsScreen> createState() => _PaymentsScreenState();
}

class _PaymentsScreenState extends ConsumerState<PaymentsScreen> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(paymentsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Payments')),
      body: switch (async) {
        AsyncData(:final value) => RefreshIndicator(
          onRefresh: () => ref.refresh(paymentsProvider.future),
          child: _body(value),
        ),
        AsyncError(:final error) => LoadFailed(error: error, onRetry: () => ref.invalidate(paymentsProvider)),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }

  Widget _body(Payments p) {
    final c = context.colors;
    final owed = p.paymentDue >= 0;
    final cycle = switch (p.settlementCycle) {
      'daily' => 'daily',
      'weekly' => 'every week',
      'biweekly' || 'fortnightly' => 'every two weeks',
      'monthly' => 'every month',
      _ => p.settlementCycle,
    };
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        const SizedBox(height: 8),
        Panel(
          tint: owed ? c.greenSoft : c.dealSoft,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(owed ? 'Payment due to you' : 'You owe Deligro', style: TextStyle(color: c.muted, fontSize: 13)),
              const SizedBox(height: 4),
              Text(
                rupees(p.paymentDue.abs()),
                style: dataStyle(context, size: 30, weight: FontWeight.w800).copyWith(color: owed ? c.green : c.deal),
              ),
              const SizedBox(height: 6),
              Text(
                owed
                    ? 'From ${p.unpaidOrders} delivered ${p.unpaidOrders == 1 ? 'order' : 'orders'} not yet paid out. Deligro settles $cycle.'
                    : 'Cash orders: you collected the money, so Deligro\'s charges are deducted from your next payout.',
                style: TextStyle(color: c.muted, fontSize: 13),
              ),
              if (p.outstandingCorrections > 0) ...[
                const SizedBox(height: 6),
                Text(
                  'Includes ${rupees(p.outstandingCorrections)} being recovered for refunded orders.',
                  style: TextStyle(color: c.deal, fontSize: 12.5, fontWeight: FontWeight.w600),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 12),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: TwoUp(
            gap: 10,
            children: [
              _Figure(label: 'Total earnings', value: rupees(p.totalEarnings)),
              _Figure(label: 'Settled so far', value: rupees(p.amountSettled)),
              _Figure(
                label: 'Paid orders',
                value: '${p.paidOrders}',
                note: p.partlyPaidOrders > 0 ? '${p.partlyPaidOrders} partly paid' : null,
              ),
              _Figure(label: 'Unpaid orders', value: '${p.unpaidOrders}'),
            ],
          ),
        ),
        const SectionHeading('How it adds up'),
        _Breakdown(b: p.breakdown, commissionPct: p.commissionPct),
        const SizedBox(height: 16),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: SegmentedButton<int>(
            segments: [
              ButtonSegment(value: 0, label: Text('Settlements · ${p.settlements.length}')),
              ButtonSegment(value: 1, label: Text('Unpaid · ${p.unpaid.length}')),
            ],
            selected: {_tab},
            showSelectedIcon: false,
            onSelectionChanged: (s) => setState(() => _tab = s.first),
          ),
        ),
        const SizedBox(height: 8),
        if (_tab == 0) ..._settlements(p) else ..._unpaid(p),
      ],
    );
  }

  List<Widget> _settlements(Payments p) {
    final c = context.colors;
    if (p.settlements.isEmpty) {
      return [_empty('No settlements yet. Once Deligro pays out, each payment shows here with its statement.')];
    }
    return [
      for (final s in p.settlements)
        ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 2),
          leading: CircleAvatar(
            backgroundColor: s.status == 'void' ? c.surface2 : c.greenSoft,
            child: Icon(
              s.status == 'void' ? Icons.block_rounded : Icons.account_balance_rounded,
              color: s.status == 'void' ? c.muted : c.green,
              size: 20,
            ),
          ),
          title: Text(s.periodLabel, style: const TextStyle(fontWeight: FontWeight.w700)),
          subtitle: Text(
            s.status == 'void'
                ? 'Voided · ${s.orderCount} orders'
                : 'Paid ${s.paidAt == null ? '' : DateFormat('d MMM', 'en_IN').format(s.paidAt!)} · ${s.orderCount} orders',
            style: TextStyle(color: c.muted, fontSize: 13),
          ),
          trailing: Text(
            rupees(s.netPayable),
            style: dataStyle(context, size: 15, weight: FontWeight.w800).copyWith(
              decoration: s.status == 'void' ? TextDecoration.lineThrough : null,
              color: s.status == 'void' ? c.muted : null,
            ),
          ),
          onTap: () => context.push('/payments/${s.id}'),
        ),
    ];
  }

  List<Widget> _unpaid(Payments p) {
    final c = context.colors;
    if (p.unpaid.isEmpty) return [_empty('Every delivered order has been paid out.')];
    return [
      for (final o in p.unpaid)
        ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 2),
          title: Text(o.code, style: dataStyle(context, size: 14.5, weight: FontWeight.w800)),
          subtitle: Text(
            '${placedAt(o.deliveredAt)} · ${o.paymentMethod == 'online' ? 'Online' : 'Cash'} · sale ${rupees(o.sale)} − charges ${rupees(o.charges)}',
            style: TextStyle(color: c.muted, fontSize: 12.5),
          ),
          trailing: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(rupees(o.earnings), style: dataStyle(context, size: 14.5, weight: FontWeight.w800)),
              Text(
                o.contribution >= 0 ? '+${rupees(o.contribution)} payout' : '${rupees(o.contribution)} payout',
                style: TextStyle(
                  color: o.contribution >= 0 ? c.green : c.deal,
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          onTap: () => context.push('/orders/${o.orderId}'),
        ),
    ];
  }

  Widget _empty(String text) => Padding(
    padding: const EdgeInsets.all(32),
    child: Text(
      text,
      textAlign: TextAlign.center,
      style: TextStyle(color: context.colors.muted),
    ),
  );
}

/// Every delivered order's money, from what customers paid down to what the
/// shop earns and what is still to be paid out.
class _Breakdown extends StatelessWidget {
  const _Breakdown({required this.b, required this.commissionPct});

  final PaymentsBreakdown b;
  final double commissionPct;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget row(String k, int v, {bool minus = false, bool bold = false, String? note}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(k, style: TextStyle(fontWeight: bold ? FontWeight.w800 : FontWeight.w500)),
                if (note != null) Text(note, style: TextStyle(color: c.muted, fontSize: 12)),
              ],
            ),
          ),
          Text(
            minus && v != 0 ? '− ${rupees(v)}' : rupees(v),
            style: dataStyle(context, size: bold ? 16 : 14, weight: bold ? FontWeight.w800 : FontWeight.w600),
          ),
        ],
      ),
    );
    final pct = commissionPct % 1 == 0 ? commissionPct.toStringAsFixed(0) : commissionPct.toStringAsFixed(1);
    return Panel(
      child: Column(
        children: [
          row('Total order value', b.orderValue, note: 'What customers paid, incl. delivery and taxes'),
          row('Collected online', b.collectedOnline, note: 'Held by Deligro until payout'),
          row('Collected in cash', b.collectedCash, note: 'Collected at the door'),
          const Divider(height: 18),
          row('Food sales', b.foodSales + b.vendorDiscounts),
          row('Your discounts', b.vendorDiscounts, minus: true),
          row('Deligro commission ($pct%)', b.commission, minus: true),
          row('GST on commission', b.commissionGst, minus: true),
          if (b.otherCharges > 0) row('Other charges', b.otherCharges, minus: true),
          if (b.refunds > 0) row('Refunds recovered', b.refunds, minus: true),
          const Divider(height: 18),
          row('Net earnings', b.netEarnings, bold: true),
          row('Pending settlement', b.pendingSettlement, note: 'Earned, not yet paid out'),
        ],
      ),
    );
  }
}

class _Figure extends StatelessWidget {
  const _Figure({required this.label, required this.value, this.note});

  final String label;
  final String value;
  final String? note;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(label, style: TextStyle(color: c.muted, fontSize: 12.5)),
          const SizedBox(height: 2),
          FittedBox(
            child: Text(value, style: dataStyle(context, size: 18, weight: FontWeight.w800)),
          ),
          if (note != null)
            Text(
              note!,
              style: TextStyle(color: c.deal, fontSize: 11, fontWeight: FontWeight.w600),
            ),
        ],
      ),
    );
  }
}
