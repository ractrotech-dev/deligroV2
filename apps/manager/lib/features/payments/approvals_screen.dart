import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/outcome.dart';
import '../../models/payment_request.dart';
import '../../models/rider.dart' show ymd;
import '../../state/payments.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/reason_dialog.dart';
import 'payment_labels.dart';

/// Approvals (§5.13, §7): payments one person asked for and a different
/// person approves. The requester never sees Approve on their own request;
/// the server refuses it too (`same_person`). Approving records the bank or
/// UPI reference; if what is owed changed since the request, the approver
/// confirms the new figure before anything is paid.
class ApprovalsScreen extends ConsumerStatefulWidget {
  const ApprovalsScreen({super.key, this.query});

  /// `?id=<request>` (a push) opens on Waiting with that request first.
  final Uri? query;

  @override
  ConsumerState<ApprovalsScreen> createState() => _ApprovalsScreenState();
}

enum _Tab { waiting, approved, rejected, mine }

class _ApprovalsScreenState extends ConsumerState<ApprovalsScreen> {
  _Tab _tab = _Tab.waiting;

  /// `?kind=vendor_settlement` (Finance → Pending approvals) shows one kind,
  /// filtered on the server so later pages of that kind are never hidden.
  PaymentKind? get _kind {
    final k = PaymentKind.parse(widget.query?.queryParameters['kind']);
    return k == PaymentKind.unknown ? null : k;
  }

  PaymentRequestFilters _filters(String? zoneId) => switch (_tab) {
        _Tab.waiting => PaymentRequestFilters(status: PaymentStatus.pendingApproval, zoneId: zoneId, kind: _kind),
        _Tab.approved => PaymentRequestFilters(status: PaymentStatus.approved, zoneId: zoneId, kind: _kind),
        _Tab.rejected => PaymentRequestFilters(status: PaymentStatus.rejected, zoneId: zoneId, kind: _kind),
        _Tab.mine => PaymentRequestFilters(mine: true, zoneId: zoneId, kind: _kind),
      };

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final zone = ref.watch(activeZoneProvider);
    final f = _filters(zone?.id);
    final value = ref.watch(paymentListProvider(f));
    final data = value.value;
    final waiting = data?.counts.pendingApproval;
    final focus = widget.query?.queryParameters['id'];
    final items = [...?data?.items]..sort((a, b) => (b.id == focus ? 1 : 0) - (a.id == focus ? 1 : 0));

    Widget tab(_Tab t, String label) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            key: Key('approvals-tab-${t.name}'),
            label: Text(label),
            selected: _tab == t,
            onSelected: (_) => setState(() => _tab = t),
          ),
        );

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Approvals'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: Row(
              children: [
                tab(_Tab.waiting, waiting == null ? 'Waiting' : 'Waiting ($waiting)'),
                tab(_Tab.approved, 'Approved'),
                tab(_Tab.rejected, 'Rejected'),
                tab(_Tab.mine, 'Mine'),
              ],
            ),
          ),
          Expanded(
            child: data == null
                ? (value.hasError
                    ? ErrorRetry(error: value.error!, onRetry: () => ref.invalidate(paymentListProvider(f)))
                    : const Center(child: CircularProgressIndicator()))
                : RefreshIndicator(
                    onRefresh: () => ref.read(paymentListProvider(f).notifier).refresh(),
                    child: items.isEmpty
                        ? ListView(
                            physics: const AlwaysScrollableScrollPhysics(),
                            children: [
                              EmptyLine(_tab == _Tab.waiting ? 'Nothing is waiting for approval.' : 'Nothing here.'),
                            ],
                          )
                        : ListView.separated(
                            physics: const AlwaysScrollableScrollPhysics(),
                            padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
                            itemCount: items.length,
                            separatorBuilder: (_, _) => const SizedBox(height: 10),
                            itemBuilder: (_, i) => PaymentRequestCard(
                              request: items[i],
                              filters: f,
                              highlighted: items[i].id == focus,
                            ),
                          ),
                  ),
          ),
        ],
      ),
    );
  }
}

/// Rider money keeps paise; a vendor settlement is whole rupees.
String _money(PaymentRequest r, num amount) => r.kind.isVendor ? rupees(amount) : rupeesPaise(amount);

/// One request with the decisions this viewer may take on it.
class PaymentRequestCard extends ConsumerWidget {
  const PaymentRequestCard({super.key, required this.request, required this.filters, this.highlighted = false});
  final PaymentRequest request;
  final PaymentRequestFilters filters;
  final bool highlighted;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final r = request;
    final me = ref.watch(managerMeProvider).value;
    final mine = r.requestedBy != null && r.requestedBy!.id == me?.profile.id;
    final canWithdraw = mine && r.pending && (me?.can('manager.finance.initiate_payment') ?? false);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: highlighted ? c.accentSoft : c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: highlighted ? c.accent : c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  [r.subject.name, ?r.subject.code].join(' · '),
                  style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15),
                ),
              ),
              Flexible(child: StatusText(r.status.label, color: paymentStatusColor(c, r.status))),
            ],
          ),
          const SizedBox(height: 6),
          Text(_money(r, r.amount), style: dataStyle(context, size: 20, weight: FontWeight.w800)),
          const SizedBox(height: 4),
          Text(
            [
              r.kind.label,
              if (r.periodEnd != null) 'to ${r.periodEnd}',
              if (r.salaryAmount != null) 'salary ${rupeesPaise(r.salaryAmount!)}',
              r.method.label,
              if (r.zone != null) r.zone!.name,
            ].join(' · '),
            style: TextStyle(fontSize: 12.5, color: c.muted),
          ),
          Text(
            'Asked by ${r.requestedBy?.name ?? 'someone'} · ${placedAt(r.requestedAt)}',
            style: TextStyle(fontSize: 12.5, color: c.muted),
          ),
          if (r.note != null) Text(r.note!, style: TextStyle(fontSize: 13, color: c.ink)),
          if (r.kind.isVendor && r.settlementId != null)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                key: Key('open-settlement-${r.id}'),
                style: TextButton.styleFrom(padding: EdgeInsets.zero, visualDensity: VisualDensity.compact),
                onPressed: () => context.push('/finance/settlements/${r.settlementId}'),
                child: const Text('Open settlement'),
              ),
            ),
          if (r.decidedBy != null)
            Text(
              [
                '${r.status.label} by ${r.decidedBy!.name}',
                placedAt(r.decidedAt),
                if (r.reference != null) 'Ref ${r.reference}',
                if (r.paidOn != null) 'paid ${r.paidOn}',
                ?r.decisionNote,
              ].where((s) => s.isNotEmpty).join(' · '),
              style: TextStyle(fontSize: 12.5, color: c.ink),
            ),
          if (r.selfApproved)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                'Self-approved by admin',
                style: TextStyle(fontSize: 12.5, color: c.amberText, fontWeight: FontWeight.w600),
              ),
            ),
          if (r.pending && mine && !r.canDecide)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                'You asked for this — another person must approve it.',
                style: TextStyle(fontSize: 12.5, color: c.amberText, fontWeight: FontWeight.w600),
              ),
            ),
          if (r.pending && (r.canDecide || canWithdraw))
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  if (r.canDecide) ...[
                    FilledButton(
                      key: Key('pr-approve-${r.id}'),
                      onPressed: () => _approve(context, ref, r, filters, ownRequest: mine),
                      child: const Text('Approve'),
                    ),
                    OutlinedButton(
                      key: Key('pr-reject-${r.id}'),
                      style: OutlinedButton.styleFrom(foregroundColor: c.deal),
                      onPressed: () => _reject(context, ref, r, filters),
                      child: const Text('Reject'),
                    ),
                  ],
                  if (canWithdraw)
                    OutlinedButton(
                      key: Key('pr-withdraw-${r.id}'),
                      onPressed: () => _withdraw(context, ref, r, filters),
                      child: const Text('Withdraw'),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Sends [d]; a fault offers Retry with the same decision. `amount_changed`
/// asks the approver to confirm the new figure and re-sends with
/// `confirmAmount` and the same id.
Future<void> _send(
  BuildContext context,
  WidgetRef ref,
  PaymentRequest r,
  PaymentRequestFilters f,
  PaymentDecision d, {
  required String doneText,
}) async {
  final Outcome<PaymentRequest> out;
  try {
    out = await ref.read(paymentListProvider(f).notifier).decide(r.id, d);
  } on ApiException catch (e) {
    if (e.unauthorized) {
      await handleUnauthorized(ref, e);
      return;
    }
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text(e.friendly),
        action: SnackBarAction(label: 'Retry', onPressed: () => _send(context, ref, r, f, d, doneText: doneText)),
      ));
    return;
  }
  if (!context.mounted) return;
  switch (out) {
    case Applied():
      showSnack(context, doneText);
    case Refused(code: 'amount_changed', :final reasons):
      final now = double.tryParse(reasons.firstOrNull ?? '');
      if (now == null) {
        showSnack(context, 'The amount changed. Refresh and try again.');
        return;
      }
      final go = await confirm(
        context,
        title: 'The amount changed',
        message: 'The amount is now ${_money(r, now)} (was ${_money(r, r.amount)}). Approve ${_money(r, now)}?',
        yes: 'Approve ${_money(r, now)}',
      );
      if (go && context.mounted) {
        // A settlement's first id is spent on the refusal (the server rebuilt
        // the draft), so the confirmed approval is a new decision; a rider
        // payout's re-send is the same decision with the amount confirmed.
        final next = r.kind == PaymentKind.vendorSettlement
            ? PaymentDecision(
                decision: d.decision,
                reference: d.reference,
                paidOn: d.paidOn,
                note: d.note,
                confirmAmount: now,
              )
            : d.confirming(now);
        await _send(context, ref, r, f, next, doneText: doneText);
      } else {
        await ref.read(paymentListProvider(f).notifier).refresh();
      }
    case Refused():
      showSnack(context, paymentRefusalText(out));
  }
}

Future<void> _approve(
  BuildContext context,
  WidgetRef ref,
  PaymentRequest r,
  PaymentRequestFilters f, {
  bool ownRequest = false,
}) async {
  final d = await showDialog<PaymentDecision>(
    context: context,
    builder: (_) => _ApproveDialog(request: r, ownRequest: ownRequest),
  );
  if (d == null || !context.mounted) return;
  await _send(context, ref, r, f, d, doneText: 'Approved and recorded as paid.');
}

Future<void> _reject(BuildContext context, WidgetRef ref, PaymentRequest r, PaymentRequestFilters f) async {
  final note = await showReasonDialog(
    context,
    title: 'Reject this payment?',
    quickPicks: const ['Wrong period', 'Amount needs checking', 'Paid another way'],
    hint: 'Why?',
    submitLabel: 'Reject',
  );
  if (note == null || !context.mounted) return;
  await _send(context, ref, r, f, PaymentDecision(decision: PaymentDecisionKind.reject, note: note),
      doneText: 'Payment rejected.');
}

Future<void> _withdraw(BuildContext context, WidgetRef ref, PaymentRequest r, PaymentRequestFilters f) async {
  final go = await confirm(
    context,
    title: 'Withdraw this request?',
    message: 'Nothing is paid. You can ask again later.',
    yes: 'Withdraw',
  );
  if (!go || !context.mounted) return;
  await _send(context, ref, r, f, PaymentDecision(decision: PaymentDecisionKind.cancel), doneText: 'Request withdrawn.');
}

class _ApproveDialog extends StatefulWidget {
  const _ApproveDialog({required this.request, this.ownRequest = false});
  final PaymentRequest request;

  /// An admin approving their own request (one-admin payments): the server
  /// refuses it without a reason, so the note becomes required.
  final bool ownRequest;

  @override
  State<_ApproveDialog> createState() => _ApproveDialogState();
}

class _ApproveDialogState extends State<_ApproveDialog> {
  final _ref = TextEditingController();
  final _note = TextEditingController();
  DateTime _paidOn = istToday();

  @override
  void dispose() {
    _ref.dispose();
    _note.dispose();
    super.dispose();
  }

  /// A reversal moves no money: it confirms the transfer never arrived, so the
  /// payout is voided. Its bank reference is optional.
  bool get _reversal => widget.request.kind == PaymentKind.settlementReversal;

  bool get _ok =>
      (_reversal || _ref.text.trim().length >= 3) && (!widget.ownRequest || _note.text.trim().length >= 3);

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(_reversal
            ? 'Reverse the ${_money(widget.request, widget.request.amount)} payout?'
            : 'Approve ${_money(widget.request, widget.request.amount)}?'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                  _reversal
                      ? "Approve only once the bank confirms the transfer didn't reach the shop. The payout becomes void and its orders can be paid again."
                      : 'Approving records the payment as made. Pay first, then enter its reference.',
                  style: TextStyle(color: context.colors.muted, fontSize: 13)),
              const SizedBox(height: 10),
              TextField(
                key: const Key('approve-reference'),
                controller: _ref,
                textCapitalization: TextCapitalization.characters,
                inputFormatters: [LengthLimitingTextInputFormatter(80)],
                decoration: InputDecoration(
                    labelText: _reversal ? "Bank's return reference (optional)" : 'Bank / UPI reference (UTR)'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 8),
              if (!_reversal) Row(
                children: [
                  Expanded(child: Text('Paid on ${ymd(_paidOn)}')),
                  TextButton(
                    key: const Key('approve-paid-on'),
                    onPressed: () async {
                      final today = istToday();
                      final d = await showDatePicker(
                        context: context,
                        initialDate: _paidOn,
                        firstDate: DateTime(today.year - 1),
                        lastDate: today,
                      );
                      if (d != null) setState(() => _paidOn = d);
                    },
                    child: const Text('Change'),
                  ),
                ],
              ),
              TextField(
                key: const Key('approve-note'),
                controller: _note,
                inputFormatters: [LengthLimitingTextInputFormatter(500)],
                decoration: InputDecoration(
                  labelText: widget.ownRequest ? 'Reason (you are approving your own request)' : 'Note (optional)',
                ),
                onChanged: (_) => setState(() {}),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Back')),
          FilledButton(
            key: const Key('approve-submit'),
            onPressed: _ok
                ? () => Navigator.pop(
                      context,
                      PaymentDecision(
                        decision: PaymentDecisionKind.approve,
                        reference: _ref.text.trim().isEmpty ? null : _ref.text.trim(),
                        paidOn: _reversal ? null : _paidOn,
                        note: _note.text.trim().isEmpty ? null : _note.text.trim(),
                      ),
                    )
                : null,
            child: Text(_reversal ? 'Approve reversal' : 'Approve'),
          ),
        ],
      );
}
