import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/finance.dart';
import '../../state/finance.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import 'finance_list.dart';
import 'finance_screen.dart' show FinancePeriodChips;

/// The words for each reconciliation state, in the server's order.
const reconStateLabels = <ReconSection, Map<String, String>>{
  ReconSection.orders: {
    'paid_matched': 'Matched',
    'paid_mismatch': 'Mismatch',
    'correction_outstanding': 'Correction outstanding',
    'in_draft': 'In a draft',
    'unsettled_due': 'Unsettled, overdue',
    'unsettled_recent': 'Unsettled, recent',
  },
  ReconSection.online: {
    'matched': 'Matched',
    'online_mismatch': 'Amount differs',
    'missing_payment': 'Payment missing',
  },
  ReconSection.cash: {
    'settled': 'Settled',
    'pending': 'Pending',
    'disputed': 'Disputed',
  },
};

/// Reconciliation (§7 tracking 9): every delivered order against the
/// settlement that paid it, online payments against order totals, and cash
/// collected against cash deposited. A `manager.cash`-only manager sees Cash.
class ReconciliationScreen extends ConsumerStatefulWidget {
  const ReconciliationScreen({super.key});

  @override
  ConsumerState<ReconciliationScreen> createState() => _ReconciliationScreenState();
}

class _ReconciliationScreenState extends ConsumerState<ReconciliationScreen> {
  ReconSection? _section;
  String? _state;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final finance = me?.can('manager.finance.view') ?? false;
    final sections = finance ? ReconSection.values : const [ReconSection.cash];
    final section = sections.contains(_section) ? _section! : sections.first;
    final args = (q: ref.watch(financeQueryProvider), section: section, state: _state);
    final value = ref.watch(reconciliationProvider(args));
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Reconciliation'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(reconciliationProvider(args).future),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          children: [
            const FinancePeriodChips(),
            if (sections.length > 1)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: SegmentedButton<ReconSection>(
                  segments: [for (final s in sections) ButtonSegment(value: s, label: Text(s.label))],
                  selected: {section},
                  onSelectionChanged: (s) => setState(() {
                    _section = s.first;
                    _state = null;
                  }),
                ),
              ),
            if (!value.hasValue && value.hasError)
              ErrorRetry(error: value.error!, onRetry: () => ref.invalidate(reconciliationProvider(args)))
            else if (!value.hasValue)
              const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator()))
            else
              ..._content(context, value.requireValue, section,
                  onLoadMore: () => ref.read(reconciliationProvider(args).notifier).loadMore()),
          ],
        ),
      ),
    );
  }

  List<Widget> _content(BuildContext context, Reconciliation r, ReconSection section, {required VoidCallback onLoadMore}) {
    final c = context.colors;
    final labels = reconStateLabels[section]!;
    final chips = section == ReconSection.cash
        ? [for (final e in labels.entries) (e.key, e.value)]
        : [for (final e in labels.entries) (e.key, '${e.value} (${count(r.summary[e.key] ?? 0)})')];
    return [
      if (section == ReconSection.cash)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
          child: Wrap(spacing: 18, runSpacing: 6, children: [
            _Fig('Collected', rupees(r.summary['collected'] ?? 0)),
            _Fig('Deposited', rupees(r.summary['deposited'] ?? 0)),
            _Fig('Pending', rupees(r.summary['pending'] ?? 0), warn: (r.summary['pending'] ?? 0) > 0),
            _Fig('Disputed days', count(r.summary['disputedDays'] ?? 0), warn: (r.summary['disputedDays'] ?? 0) > 0),
          ]),
        ),
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 6),
        child: Row(children: [
          for (final (key, label) in chips)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: FilterChip(
                key: Key('recon-state-$key'),
                label: Text(label),
                selected: _state == key,
                onSelected: (on) => setState(() => _state = on ? key : null),
              ),
            ),
        ]),
      ),
      if (r.itemCount == 0) const EmptyLine('Nothing in this view.'),
      for (final o in r.orderItems) _OrderRow(item: o),
      for (final o in r.onlineItems) _OnlineRow(item: o),
      for (final x in r.cashItems) _CashRow(item: x),
      if (r.managers.isNotEmpty) ...[
        const GroupLabel('Managers: received and handed on'),
        for (final m in r.managers)
          FinanceRow(
            child: Row(children: [
              Expanded(
                child: Text('${m.manager.name} · ${m.day}', style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
              ),
              Text('${rupees(m.received)} in · ${rupees(m.handedOn)} on',
                  style: dataStyle(context, size: 13)),
              if (m.pending > 0)
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: Text(rupees(m.pending), style: dataStyle(context, size: 13).copyWith(color: c.amberText)),
                ),
            ]),
          ),
      ],
      if (r.nextCursor != null)
        Padding(
          padding: const EdgeInsets.all(16),
          child: Center(
            child: OutlinedButton(
              key: const Key('recon-load-more'),
              onPressed: onLoadMore,
              child: Text('Show more (${r.itemCount} shown)'),
            ),
          ),
        ),
    ];
  }
}

class _Fig extends StatelessWidget {
  const _Fig(this.label, this.value, {this.warn = false});
  final String label;
  final String value;
  final bool warn;

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: TextStyle(fontSize: 12, color: context.colors.muted)),
        Text(value,
            style: dataStyle(context, size: 16, weight: FontWeight.w800)
                .copyWith(color: warn ? context.colors.amberText : context.colors.ink)),
      ]);
}

class _OrderRow extends StatelessWidget {
  const _OrderRow({required this.item});
  final OrderRecon item;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final o = item;
    final label = reconStateLabels[ReconSection.orders]![o.state] ?? o.state;
    final bad = o.state == 'paid_mismatch' || o.state == 'unsettled_due' || o.state == 'correction_outstanding';
    return FinanceRow(
      onTap: () => context.push(o.settlementId == null ? '/orders/${o.orderId}' : '/finance/settlements/${o.settlementId}'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(o.orderCode, style: dataStyle(context, size: 14.5, weight: FontWeight.w800))),
          Text(rupeesSigned(o.difference),
              style: dataStyle(context, size: 14.5, weight: FontWeight.w800).copyWith(color: o.difference < 0 ? c.deal : c.ink)),
        ]),
        Text(
          [
            ?o.vendor?.name,
            'expected ${rupees(o.expected)}',
            o.settled == null ? 'not settled' : 'settled ${rupees(o.settled!)}',
            if (o.deliveredAt != null) 'delivered ${placedAt(o.deliveredAt)}',
          ].join(' · '),
          style: TextStyle(fontSize: 12.5, color: c.muted),
        ),
        StatusText(label, color: bad ? c.amberText : (o.state == 'paid_matched' ? c.green : c.muted)),
      ]),
    );
  }
}

class _OnlineRow extends StatelessWidget {
  const _OnlineRow({required this.item});
  final OnlineRecon item;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final o = item;
    final label = reconStateLabels[ReconSection.online]![o.state] ?? o.state;
    return FinanceRow(
      onTap: () => context.push('/orders/${o.orderId}'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(o.orderCode, style: dataStyle(context, size: 14.5, weight: FontWeight.w800))),
          Text(o.paidAmount == null ? 'no payment' : '${rupees(o.paidAmount!)} of ${rupees(o.orderTotal)}',
              style: dataStyle(context, size: 13.5)),
        ]),
        StatusText(label, color: o.state == 'matched' ? c.green : c.amberText),
        if (o.paymentId != null) ReferenceText(o.paymentId!, copyKey: Key('copy-pay-${o.orderId}'), prefix: 'Payment '),
      ]),
    );
  }
}

class _CashRow extends StatelessWidget {
  const _CashRow({required this.item});
  final CashRecon item;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final x = item;
    final label = reconStateLabels[ReconSection.cash]![x.status] ?? x.status;
    final color = switch (x.status) { 'settled' => c.green, 'disputed' => c.deal, _ => c.amberText };
    return FinanceRow(
      onTap: () => context.push('/more/cash'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(x.rider.name, style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15))),
          Text(x.day, style: dataStyle(context, size: 13)),
        ]),
        Text(
          [
            ?x.rider.code,
            'collected ${rupees(x.collected)}',
            'deposited ${rupees(x.deposited)}',
            if (x.pending != 0) 'pending ${rupees(x.pending)}',
          ].join(' · '),
          style: TextStyle(fontSize: 12.5, color: c.muted),
        ),
        StatusText(label, color: color),
      ]),
    );
  }
}
