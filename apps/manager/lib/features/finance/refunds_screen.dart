import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/finance.dart';
import '../../models/outcome.dart';
import '../../state/finance.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/reason_dialog.dart';
import 'finance_list.dart';

/// Refunds and adjustments (§7 sales 5): the queue, waiting ones first.
/// Deciding needs `manager.finance.adjust`; every decision carries a reason.
class RefundsScreen extends ConsumerStatefulWidget {
  const RefundsScreen({super.key, this.query});

  /// `?id=<refund>` puts that refund first.
  final Uri? query;

  @override
  ConsumerState<RefundsScreen> createState() => _RefundsScreenState();
}

class _RefundsScreenState extends ConsumerState<RefundsScreen> {
  RefundStatus _status = RefundStatus.pending;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final args = (q: ref.watch(financeQueryProvider), status: _status);
    final value = ref.watch(refundsProvider(args));
    final canDecide = ref.watch(managerMeProvider).value?.can('manager.finance.adjust') ?? false;
    final focus = widget.query?.queryParameters['id'];
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Refunds'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: FinancePagedList(
        value: value,
        onRetry: () => ref.invalidate(refundsProvider(args)),
        onRefresh: () => ref.read(refundsProvider(args).notifier).refresh(),
        onLoadMore: () => ref.read(refundsProvider(args).notifier).loadMore(),
        emptyText: _status == RefundStatus.pending ? 'No refund is waiting.' : 'No refunds here.',
        header: (data) => [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
            child: Row(children: [
              for (final s in [RefundStatus.pending, RefundStatus.approved, RefundStatus.denied])
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: ChoiceChip(
                    label: Text(s == RefundStatus.pending && data != null ? 'Waiting (${data.counts})' : s.label),
                    selected: _status == s,
                    onSelected: (_) => setState(() => _status = s),
                  ),
                ),
            ]),
          ),
          if (!canDecide)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
              child: Text('You can see refunds. Deciding them needs Finance adjustments switched on.',
                  style: TextStyle(fontSize: 12.5, color: c.muted)),
            ),
        ],
        itemBuilder: (context, r) => _RefundRow(
          refund: r,
          canDecide: canDecide,
          highlighted: r.id == focus,
          onDecide: (approve) => _decide(r, approve, args),
        ),
      ),
    );
  }

  Future<void> _decide(RefundItem r, bool approve, RefundArgs args) async {
    final reason = await showReasonDialog(
      context,
      title: approve ? 'Approve refund of ${rupees(r.amount)}?' : 'Deny refund of ${rupees(r.amount)}?',
      quickPicks: approve
          ? const ['Item missing, confirmed', 'Order not delivered', 'Wrong item delivered']
          : const ['Already refunded in cash', 'Customer received the order', 'Duplicate request'],
      submitLabel: approve ? 'Approve refund' : 'Deny refund',
      message: 'Order ${r.order.code} · total ${rupees(r.order.total)}',
    );
    if (reason == null || !mounted) return;
    await _send(r, RefundDecision(approve: approve, reason: reason), args);
  }

  /// Sends [d]; on `effect_failed` (decision saved, its after-effects not
  /// finished) or any fault, Retry re-sends the same decision and id.
  Future<void> _send(RefundItem r, RefundDecision d, RefundArgs args) async {
    final Outcome<RefundItem> out;
    try {
      out = await ref.read(financeRepoProvider).decideRefund(r.id, d);
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      final text = e.code == 'effect_failed' ? 'Decision saved; finishing it failed — retry' : e.friendly;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text(text),
          duration: const Duration(seconds: 10),
          action: SnackBarAction(label: 'Retry', onPressed: () => _send(r, d, args)),
        ));
      return;
    }
    if (!mounted) return;
    switch (out) {
      case Applied():
        showSnack(context, d.approve ? 'Refund approved.' : 'Refund denied.');
      case Refused(:final code):
        showSnack(
          context,
          switch (code) {
            'already_decided' => 'Someone already decided this refund. Showing the latest.',
            'reason_required' => 'Give a reason of at least 3 characters.',
            'permission_denied' || 'forbidden' => "You don't have permission to decide refunds.",
            _ => "That didn't go through ($code).",
          },
        );
    }
    await ref.read(refundsProvider(args).notifier).refresh();
  }
}

class _RefundRow extends StatelessWidget {
  const _RefundRow({required this.refund, required this.canDecide, required this.onDecide, this.highlighted = false});
  final RefundItem refund;
  final bool canDecide;
  final bool highlighted;
  final void Function(bool approve) onDecide;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final r = refund;
    final color = switch (r.status) {
      RefundStatus.pending => c.amberText,
      RefundStatus.approved => c.green,
      RefundStatus.denied => c.deal,
      RefundStatus.unknown => c.muted,
    };
    final effect = switch (r.settlementEffect) {
      'draft_flagged' => 'The shop\'s draft settlement will take it off',
      'correction_created' => 'Recovered from the shop through a settlement correction',
      _ => null,
    };
    return FinanceRow(
      selected: highlighted,
      onTap: () => context.push('/orders/${r.order.id}'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(r.order.code, style: dataStyle(context, size: 15, weight: FontWeight.w800))),
          Text(rupees(r.amount), style: dataStyle(context, size: 16, weight: FontWeight.w800)),
        ]),
        Text(
          [
            ?r.vendor?.name,
            r.origin.label,
            switch (r.order.paymentMethod) { 'cod' => 'Cash order', 'online' => 'Paid online', _ => null },
            if (r.requestedAt != null) placedAt(r.requestedAt),
          ].whereType<String>().join(' · '),
          style: TextStyle(fontSize: 12.5, color: c.muted),
        ),
        if (r.reason != null) Text(r.reason!, style: TextStyle(fontSize: 13, color: c.ink)),
        const SizedBox(height: 3),
        StatusText(r.decidedBy == null ? r.status.label : '${r.status.label} by ${r.decidedBy!.name}', color: color),
        if (effect != null) Text(effect, style: TextStyle(fontSize: 12.5, color: c.muted)),
        if (r.providerRefundId != null)
          ReferenceText(r.providerRefundId!, copyKey: Key('copy-refund-${r.id}'), prefix: 'Gateway refund '),
        if (canDecide && r.status == RefundStatus.pending)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Wrap(spacing: 8, children: [
              FilledButton(key: Key('refund-approve-${r.id}'), onPressed: () => onDecide(true), child: const Text('Approve')),
              OutlinedButton(
                key: Key('refund-deny-${r.id}'),
                style: OutlinedButton.styleFrom(foregroundColor: c.deal),
                onPressed: () => onDecide(false),
                child: const Text('Deny'),
              ),
            ]),
          ),
      ]),
    );
  }
}
