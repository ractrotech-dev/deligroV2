import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/payment_request.dart';
import '../../models/settlement.dart';
import '../../state/finance.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../orders/order_labels.dart' show StatusText;
import '../payments/payment_labels.dart';
import 'finance_list.dart';
import 'settlements_screen.dart' show settlementStatusColor;

/// One settlement: the figures, its approval request, corrections and lines.
class SettlementDetailScreen extends StatelessWidget {
  const SettlementDetailScreen({super.key, required this.settlementId});
  final String settlementId;

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: context.colors.bg,
        appBar: AppBar(title: const Text('Settlement'), backgroundColor: context.colors.bg),
        body: SettlementDetailBody(settlementId: settlementId),
      );
}

class SettlementDetailBody extends ConsumerWidget {
  const SettlementDetailBody({super.key, required this.settlementId});
  final String settlementId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(settlementDetailProvider(settlementId));
    return AsyncView(
      value: value,
      onRetry: () => ref.invalidate(settlementDetailProvider(settlementId)),
      builder: (d) => RefreshIndicator(
        onRefresh: () => ref.refresh(settlementDetailProvider(settlementId).future),
        child: _Detail(detail: d),
      ),
    );
  }
}

class _Detail extends StatelessWidget {
  const _Detail({required this.detail});
  final SettlementDetail detail;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = detail.settlement;
    final r = detail.request;
    Widget fact(String label, String value, {bool strong = false}) => Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 5),
          child: Row(children: [
            Expanded(child: Text(label, style: TextStyle(color: c.muted, fontSize: 13.5))),
            Text(value, style: dataStyle(context, size: strong ? 17 : 14, weight: strong ? FontWeight.w800 : FontWeight.w600)),
          ]),
        );
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 2),
          child: Text(s.vendor.name, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: c.ink)),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Text(
            [
              s.kind == SettlementKind.instant ? 'One order' : '${s.periodStart} to ${s.periodEnd}',
              if (s.zone != null) s.zone!.name,
            ].join(' · '),
            style: TextStyle(color: c.muted),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
          child: StatusText(s.statusLabel, color: settlementStatusColor(c, s), size: 14),
        ),
        if (detail.stale)
          Container(
            margin: const EdgeInsets.fromLTRB(16, 6, 16, 6),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(radiusBlock)),
            child: Text(
              'A refund landed since this draft was made. Approving rebuilds it'
              '${detail.freshNetPayable == null ? '' : ' at ${rupeesSigned(detail.freshNetPayable!)}'}.',
              style: TextStyle(color: c.deal, fontWeight: FontWeight.w600),
            ),
          ),
        const GroupLabel('Money'),
        fact('Net payable', rupeesSigned(s.netPayable), strong: true),
        fact('Food value', rupees(s.foodGross)),
        fact('Platform commission', rupees(s.commission)),
        fact('GST on commission', rupees(s.commissionGst)),
        fact('Other charges', rupees(s.otherCharges)),
        fact('Refunds recovered', rupees(s.refundsRecovered)),
        fact('Orders', count(s.orders)),
        if (s.paymentRef != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: ReferenceText(s.paymentRef!, copyKey: Key('copy-ref-detail-${s.id}'), prefix: 'Transaction reference '),
          ),
        if (s.paidAt != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
            child: Text('Paid ${placedAt(s.paidAt)}${s.paidBy == null ? '' : ' by ${s.paidBy!.name}'}',
                style: TextStyle(color: c.muted, fontSize: 13)),
          ),
        if (s.createdBy != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
            child: Text('Made by ${s.createdBy!.name} · ${placedAt(s.createdAt)}', style: TextStyle(color: c.muted, fontSize: 13)),
          ),
        if (r != null) ...[
          const GroupLabel('Approval'),
          _RequestBlock(request: r),
        ],
        if (detail.corrections.isNotEmpty) ...[
          const GroupLabel('Corrections'),
          for (final x in detail.corrections) _CorrectionRow(correction: x),
        ],
        GroupLabel('Orders (${detail.lines.length})'),
        if (detail.lines.isEmpty) const EmptyLine('No orders in this settlement.'),
        for (final l in detail.lines) _LineRow(line: l),
      ],
    );
  }
}

class _RequestBlock extends StatelessWidget {
  const _RequestBlock({required this.request});
  final PaymentRequest request;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = request;
    return FinanceRow(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          StatusText(r.status.label, color: paymentStatusColor(c, r.status)),
          Text('Asked by ${r.requestedBy?.name ?? 'someone'} · ${placedAt(r.requestedAt)} · ${r.method.label}',
              style: TextStyle(fontSize: 12.5, color: c.muted)),
          if (r.decidedBy != null)
            Text('${r.status.label} by ${r.decidedBy!.name} · ${placedAt(r.decidedAt)}',
                style: TextStyle(fontSize: 12.5, color: c.ink)),
          if (r.selfApproved)
            Text('Self-approved by admin', style: TextStyle(fontSize: 12.5, color: c.amberText, fontWeight: FontWeight.w700)),
          if (r.pending)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                onPressed: () => context.push('/more/approvals?id=${r.id}'),
                child: Text(r.canDecide ? 'Open in Approvals to decide' : 'Open in Approvals'),
              ),
            ),
        ],
      ),
    );
  }
}

class _CorrectionRow extends StatelessWidget {
  const _CorrectionRow({required this.correction});
  final SettlementCorrection correction;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final x = correction;
    final text = switch (x.status) {
      CorrectionStatus.outstanding => 'Refund approved after this payout — correction outstanding ${rupees(x.amount)}',
      CorrectionStatus.applied => 'Correction of ${rupees(x.amount)} recovered in a later settlement',
      CorrectionStatus.voided => 'Correction of ${rupees(x.amount)} voided',
      CorrectionStatus.unknown => 'Correction of ${rupees(x.amount)}',
    };
    return FinanceRow(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(text,
            style: TextStyle(
                fontWeight: FontWeight.w700,
                color: x.status == CorrectionStatus.outstanding ? c.amberText : c.ink,
                fontSize: 13.5)),
        Text(['Order ${x.orderCode}', ?x.reason].join(' · '), style: TextStyle(fontSize: 12.5, color: c.muted)),
      ]),
    );
  }
}

class _LineRow extends StatelessWidget {
  const _LineRow({required this.line});
  final SettlementLine line;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final l = line;
    return FinanceRow(
      onTap: () => context.push('/orders/${l.orderId}'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(l.orderCode, style: dataStyle(context, size: 14, weight: FontWeight.w700))),
          Text(rupeesSigned(l.contribution),
              style: dataStyle(context, size: 14, weight: FontWeight.w800).copyWith(color: l.contribution < 0 ? c.deal : c.ink)),
        ]),
        Text(
          [
            switch (l.paymentMethod) { 'cod' => 'Cash', 'online' => 'Online', _ => 'Payment unknown' },
            'total ${rupees(l.orderTotal)}',
            'food ${rupees(l.foodGross)}',
            'commission ${rupees(l.commission + l.commissionGst)}',
            if (l.refundRecovered > 0) 'refund ${rupees(l.refundRecovered)}',
          ].join(' · '),
          style: TextStyle(fontSize: 12, color: c.muted),
        ),
      ]),
    );
  }
}
