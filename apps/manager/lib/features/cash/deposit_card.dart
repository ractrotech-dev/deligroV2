import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/cash.dart';
import '../../models/outcome.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/contact_buttons.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/reason_dialog.dart';

/// What a cash refusal means, in words.
String cashRefusalText(Refused<Object?> r) => switch (r.code) {
      'already_decided' || 'already_resolved' => 'Already handled by someone else.',
      'note_required' => 'Say what is wrong — a note is needed to dispute.',
      'manual_handover_exists' =>
        "This cash was already recorded by hand for that day. Dispute the deposit instead, so it isn't counted twice.",
      'permission_denied' || 'forbidden' => "You don't have permission for that. Ask an admin.",
      'not_found' => "This isn't in your zones any more.",
      'rate_limited' => 'Too many changes at once. Wait a moment and try again.',
      _ => "That didn't go through (${r.code}).",
    };

Color depositStatusColor(AppColors c, DepositStatus s) => switch (s) {
      DepositStatus.confirmed => c.green,
      DepositStatus.submitted => c.amberText,
      DepositStatus.disputed => c.deal,
      DepositStatus.withdrawn || DepositStatus.unknown => c.muted,
    };

/// One rider deposit: amount, method, reference and receipt, with Confirm
/// and Dispute while it waits (`manager.cash`). A decision is sent once —
/// a second tap while it is in flight does nothing — and a fault offers
/// Retry with the same decision (same `clientActionId`).
class DepositCard extends ConsumerStatefulWidget {
  const DepositCard({super.key, required this.deposit, this.onChanged, this.showRider = true});
  final CashDeposit deposit;

  /// Called after a decision went through or was refused (so the list or the
  /// rider re-reads).
  final VoidCallback? onChanged;
  final bool showRider;

  @override
  ConsumerState<DepositCard> createState() => _DepositCardState();
}

class _DepositCardState extends ConsumerState<DepositCard> {
  bool _busy = false;

  /// Set once a decision has been recorded (by us or, per the server, by
  /// someone else): the buttons stay off until the list re-reads the card.
  bool _decided = false;

  @override
  void didUpdateWidget(DepositCard old) {
    super.didUpdateWidget(old);
    if (old.deposit.status != widget.deposit.status) _decided = false;
  }

  Future<void> _send(DepositDecision d) async {
    if (_busy || _decided) return;
    setState(() => _busy = true);
    try {
      final out = await ref.read(cashRepoProvider).decideDeposit(widget.deposit.id, d);
      if (!mounted) return;
      switch (out) {
        case Applied():
          _decided = true;
          showSnack(context, d.confirm ? 'Deposit confirmed.' : 'Deposit disputed.');
        case Refused(code: 'already_decided'):
          _decided = true;
          showSnack(context, cashRefusalText(out));
        case Refused():
          showSnack(context, cashRefusalText(out));
      }
      widget.onChanged?.call();
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text(e.friendly),
          action: SnackBarAction(label: 'Retry', onPressed: () => _send(d)),
        ));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _dispute() async {
    final note = await showReasonDialog(
      context,
      title: 'Dispute this deposit?',
      quickPicks: const ['Amount short', 'No UPI credit received', 'Wrong reference'],
      hint: 'What is wrong?',
      submitLabel: 'Dispute',
      message: 'The rider is told, and it stays open until it is sorted out.',
    );
    if (note == null || !mounted) return;
    await _send(DepositDecision.dispute(note));
  }

  Future<void> _photo() async {
    try {
      final url = await ref.read(cashRepoProvider).depositPhotoUrl(widget.deposit.id);
      await ref.read(urlOpenerProvider)(Uri.parse(url));
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.friendly);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = widget.deposit;
    final canDecide = ref.watch(managerMeProvider).value?.can('manager.cash') ?? false;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Wrap(
                  spacing: 10,
                  crossAxisAlignment: WrapCrossAlignment.end,
                  children: [
                    Text(rupees(d.amount), style: dataStyle(context, size: 18, weight: FontWeight.w800)),
                    Text(d.method.label, style: TextStyle(color: c.muted, fontSize: 13)),
                  ],
                ),
              ),
              Flexible(child: StatusText(d.status.label, color: depositStatusColor(c, d.status))),
            ],
          ),
          if (widget.showRider) ...[
            const SizedBox(height: 4),
            Text(
              [d.rider.name, ?d.rider.code].join(' · '),
              style: TextStyle(fontWeight: FontWeight.w700, color: c.ink),
            ),
          ],
          const SizedBox(height: 4),
          Text(
            [
              if (d.reference != null) 'Ref ${d.reference}',
              placedAt(d.createdAt),
            ].join(' · '),
            style: TextStyle(fontSize: 12.5, color: c.muted),
          ),
          if (d.note != null) ...[
            const SizedBox(height: 4),
            Text(d.note!, style: TextStyle(fontSize: 13, color: c.ink)),
          ],
          if (d.decisionNote != null || d.decidedBy != null) ...[
            const SizedBox(height: 4),
            Text(
              [if (d.decidedBy != null) d.decidedBy!.name, placedAt(d.decidedAt), ?d.decisionNote]
                  .where((s) => s.isNotEmpty)
                  .join(' · '),
              style: TextStyle(fontSize: 12.5, color: c.muted),
            ),
          ],
          if (d.hasPhoto || (canDecide && d.status == DepositStatus.submitted)) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (d.hasPhoto)
                  TextButton.icon(
                    key: Key('deposit-photo-${d.id}'),
                    onPressed: _photo,
                    icon: const Icon(Icons.receipt_long_outlined, size: 18),
                    label: const Text('Receipt'),
                  ),
                if (canDecide && d.status == DepositStatus.submitted) ...[
                  FilledButton(
                    key: Key('deposit-confirm-${d.id}'),
                    onPressed: _busy || _decided ? null : () => _send(DepositDecision.confirm()),
                    child: const Text('Confirm'),
                  ),
                  OutlinedButton(
                    key: Key('deposit-dispute-${d.id}'),
                    style: OutlinedButton.styleFrom(foregroundColor: c.deal),
                    onPressed: _busy || _decided ? null : _dispute,
                    child: const Text('Dispute'),
                  ),
                ],
              ],
            ),
          ],
        ],
      ),
    );
  }
}

/// One cash dispute a rider raised, with Resolve while it is open.
class DisputeCard extends ConsumerStatefulWidget {
  const DisputeCard({super.key, required this.dispute, this.onChanged, this.showRider = true});
  final CashDispute dispute;
  final VoidCallback? onChanged;
  final bool showRider;

  @override
  ConsumerState<DisputeCard> createState() => _DisputeCardState();
}

class _DisputeCardState extends ConsumerState<DisputeCard> {
  bool _busy = false;
  bool _decided = false;

  @override
  void didUpdateWidget(DisputeCard old) {
    super.didUpdateWidget(old);
    if (old.dispute.status != widget.dispute.status) _decided = false;
  }

  Future<void> _send(DisputeResolution r) async {
    if (_busy || _decided) return;
    setState(() => _busy = true);
    try {
      final out = await ref.read(cashRepoProvider).resolveDispute(widget.dispute.id, r);
      if (!mounted) return;
      switch (out) {
        case Applied():
          _decided = true;
          showSnack(context, 'Dispute resolved.');
        case Refused():
          showSnack(context, cashRefusalText(out));
      }
      widget.onChanged?.call();
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text(e.friendly),
          action: SnackBarAction(label: 'Retry', onPressed: () => _send(r)),
        ));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resolve() async {
    final text = await showReasonDialog(
      context,
      title: 'Resolve this dispute',
      quickPicks: const ['Recounted — rider was right', 'Recounted — amount stands', 'Settled in cash'],
      hint: 'How was it settled?',
      submitLabel: 'Resolve',
      maxLength: 500,
    );
    if (text == null || !mounted) return;
    await _send(DisputeResolution(text));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = widget.dispute;
    final canDecide = ref.watch(managerMeProvider).value?.can('manager.cash') ?? false;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  widget.showRider ? [d.rider.name, ?d.rider.code].join(' · ') : 'Day ${d.day}',
                  style: TextStyle(fontWeight: FontWeight.w700, color: c.ink),
                ),
              ),
              StatusText(d.status.label, color: d.status == DisputeStatus.open ? c.amberText : c.green),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            [
              if (widget.showRider) 'Day ${d.day}',
              if (d.claimedAmount != null) 'Says ${rupees(d.claimedAmount!)}',
            ].join(' · '),
            style: dataStyle(context, size: 13).copyWith(color: c.muted),
          ),
          const SizedBox(height: 4),
          Text(d.message, style: TextStyle(fontSize: 13.5, color: c.ink)),
          if (d.resolution != null) ...[
            const SizedBox(height: 4),
            Text('Resolved: ${d.resolution}', style: TextStyle(fontSize: 12.5, color: c.muted)),
          ],
          if (canDecide && d.status == DisputeStatus.open) ...[
            const SizedBox(height: 10),
            FilledButton(
              key: Key('dispute-resolve-${d.id}'),
              onPressed: _busy || _decided ? null : _resolve,
              child: const Text('Resolve'),
            ),
          ],
        ],
      ),
    );
  }
}
