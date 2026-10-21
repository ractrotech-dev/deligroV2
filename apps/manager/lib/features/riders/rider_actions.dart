import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/outcome.dart';
import '../../models/rider.dart';
import '../../state/riders.dart';
import '../../state/session.dart';
import '../../widgets/async_view.dart';
import '../orders/reason_dialog.dart';

/// Quick picks for each rider decision; the manager can still edit them.
abstract final class RiderPicks {
  static const approve = ['Documents verified', 'Checked in person'];
  static const reject = ['Documents invalid', 'Failed background check', 'Duplicate account'];
  static const suspend = ['Repeated no-shows', 'Customer complaints', 'Cash not deposited', 'Rider request'];
  static const reactivate = ['Issue resolved', 'Rider request'];
  static const forceOffline = ['Not answering calls', 'Shift over', 'Vehicle problem'];
  static const verifyDocument = ['Checked against the original', 'Details match'];
  static const rejectDocument = ['Blurry or unreadable', 'Expired', 'Name does not match', 'Wrong document'];
  static const adjustment = ['Rain shift', 'Extra deliveries', 'Damaged goods', 'Correction'];
}

/// What a refusal means, in words.
String riderRefusalText(Refused<Object?> r) => switch (r.code) {
      'stale' => 'Someone else changed this rider. Showing the latest.',
      'invalid_transition' => "That change doesn't apply to this rider any more.",
      'already_decided' => 'Already decided by someone else. Showing the latest.',
      'documents_unverified' => 'Required documents are not verified.',
      'active_delivery' => 'This rider has a delivery in progress. Reassign it first.',
      'reason_required' => 'Please give a reason of at least 3 characters.',
      'remarks_required' => 'Say what is wrong with the document.',
      'permission_denied' || 'forbidden' => "You don't have permission for that. Ask an admin.",
      'not_found' => "This rider isn't in your zones.",
      'rate_limited' => 'Too many changes at once. Wait a moment and try again.',
      'bad_request' => "The server didn't accept that${r.field == null ? '' : ' (${r.field})'}. Check it and try again.",
      _ => "That didn't go through (${r.code}).",
    };

/// The account and verification decisions, in the order the header shows them.
enum RiderDecision {
  approve('Approve', 'Approve this rider?', RiderPicks.approve, 'approved'),
  reject('Reject', 'Reject this rider?', RiderPicks.reject, 'rejected'),
  suspend('Suspend', 'Suspend this rider?', RiderPicks.suspend, 'suspended'),
  reactivate('Reactivate', 'Reactivate this rider?', RiderPicks.reactivate, 'reactivated'),
  forceOffline('Take offline', 'Take this rider offline?', RiderPicks.forceOffline, 'taken offline');

  const RiderDecision(this.label, this.title, this.picks, this.done);
  final String label;
  final String title;
  final List<String> picks;
  final String done;

  /// The key suffix the header's button uses.
  String get wire => this == forceOffline ? 'force_offline' : name;

  bool allowedBy(RiderAllowed a) => switch (this) {
        approve => a.approve,
        reject => a.reject,
        suspend => a.suspend,
        reactivate => a.reactivate,
        forceOffline => a.forceOffline,
      };

  bool get destructive => this == reject || this == suspend || this == forceOffline;

  String? get warning => switch (this) {
        suspend => 'They go offline at once, any offer is withdrawn, and they cannot work until reactivated.',
        forceOffline => 'They go offline now. Pending offers are released to other riders.',
        reject => 'They cannot go online while rejected.',
        _ => null,
      };

  RiderAction action(RiderDetail r, String reason) => switch (this) {
        approve => ApproveRider(expected: r.summary.verification, reason: reason),
        reject => RejectRider(expected: r.summary.verification, reason: reason),
        suspend => SuspendRider(expected: r.summary.account, reason: reason),
        reactivate => ReactivateRider(expected: r.summary.account, reason: reason),
        forceOffline => ForceOfflineRider(reason: reason),
      };
}

/// Asks why, then sends [decision] for [rider], handling every answer.
Future<void> decideRider(BuildContext context, WidgetRef ref, RiderDetail rider, RiderDecision decision) async {
  final reason = await showReasonDialog(
    context,
    title: decision.title,
    quickPicks: decision.picks,
    submitLabel: decision.label,
    message: decision.warning,
  );
  if (reason == null || !context.mounted) return;
  await sendRiderAction(context, ref, rider, decision.action(rider, reason), doneText: 'Rider ${decision.done}.');
}

/// Sends [action]. A network or server fault offers Retry with the same
/// action (same `clientActionId`); a refusal is explained — an approval
/// refused for unverified documents offers "Approve anyway", and a
/// suspension refused for an active delivery links to that order.
Future<void> sendRiderAction(
  BuildContext context,
  WidgetRef ref,
  RiderDetail rider,
  RiderAction action, {
  required String doneText,
}) async {
  final notifier = ref.read(riderDetailProvider(rider.id).notifier);
  final Outcome<RiderDetail> out;
  try {
    out = await notifier.act(action);
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
        action: SnackBarAction(
          label: 'Retry',
          onPressed: () => sendRiderAction(context, ref, rider, action, doneText: doneText),
        ),
      ));
    return;
  }
  if (!context.mounted) return;
  switch (out) {
    case Applied():
      showSnack(context, doneText);
    case Refused(code: 'documents_unverified', :final reasons) when action is ApproveRider:
      final missing = [for (final r in reasons) RiderDocType.parse(r).label];
      final go = await confirm(
        context,
        title: 'Documents not verified',
        message: [
          missing.isEmpty ? 'Required documents are not verified.' : 'Missing verified: ${missing.join(', ')}',
          '',
          'Approving anyway is recorded in the audit log.',
        ].join('\n'),
        yes: 'Approve anyway',
      );
      if (go && context.mounted) {
        await sendRiderAction(context, ref, rider, action.anyway(), doneText: doneText);
      }
    case Refused(code: 'active_delivery', :final reasons):
      await _activeDeliveryDialog(context, rider, reasons);
    case Refused():
      showSnack(context, riderRefusalText(out));
  }
}

Future<void> _activeDeliveryDialog(BuildContext context, RiderDetail rider, List<String> codes) => showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Delivery in progress'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Move their order to another rider, then try again.'),
            const SizedBox(height: 8),
            for (final code in codes.isEmpty ? const ['the active order'] : codes)
              TextButton(
                key: Key('reassign-first-$code'),
                style: TextButton.styleFrom(padding: EdgeInsets.zero, alignment: Alignment.centerLeft),
                onPressed: () {
                  Navigator.pop(ctx);
                  final match = rider.active.where((a) => a.code == code).firstOrNull;
                  final path = match != null ? '/orders/${match.orderId}' : '/orders?q=${Uri.encodeQueryComponent(code)}';
                  GoRouter.maybeOf(context)?.push(path);
                },
                child: Text('Reassign $code first'),
              ),
          ],
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Close'))],
      ),
    );

/// Verify a document (a note is optional) or reject it (remarks required).
Future<void> reviewRiderDocument(
  BuildContext context,
  WidgetRef ref,
  RiderDetail rider,
  RiderDocument doc, {
  required bool verify,
}) async {
  final text = await showReasonDialog(
    context,
    title: verify ? 'Verify ${doc.type.label}?' : 'Reject ${doc.type.label}?',
    quickPicks: verify ? RiderPicks.verifyDocument : RiderPicks.rejectDocument,
    required: !verify,
    hint: verify ? 'Note (optional)' : 'What is wrong with it?',
    submitLabel: verify ? 'Verify' : 'Reject',
  );
  if (text == null || !context.mounted) return;
  final action = verify
      ? VerifyRiderDocument(documentId: doc.id, remarks: text)
      : RejectRiderDocument(documentId: doc.id, remarks: text);
  await sendRiderAction(
    context,
    ref,
    rider,
    action,
    doneText: verify ? '${doc.type.label} verified.' : '${doc.type.label} rejected.',
  );
}

/// Bonus, deduction or adjustment (`manager.finance.adjust`) — kind, amount
/// in rupees and paise, date and a reason. Audited; no second approver.
Future<void> addRiderAdjustment(BuildContext context, WidgetRef ref, RiderDetail rider) async {
  final draft = await showDialog<AddRiderAdjustment>(context: context, builder: (_) => const _AdjustmentDialog());
  if (draft == null || !context.mounted) return;
  await sendRiderAction(context, ref, rider, draft, doneText: '${draft.kind.label} recorded.');
}

class _AdjustmentDialog extends StatefulWidget {
  const _AdjustmentDialog();

  @override
  State<_AdjustmentDialog> createState() => _AdjustmentDialogState();
}

class _AdjustmentDialogState extends State<_AdjustmentDialog> {
  AdjustmentKind _kind = AdjustmentKind.bonus;
  final _amount = TextEditingController();
  final _reason = TextEditingController();
  DateTime _date = DateTime.now();

  @override
  void dispose() {
    _amount.dispose();
    _reason.dispose();
    super.dispose();
  }

  double? get _value {
    final v = double.tryParse(_amount.text.trim());
    if (v == null || v == 0) return null;
    // Two decimal places at most (the ledger is numeric(10,2)).
    if ((v * 100).roundToDouble() != v * 100) return null;
    return v;
  }

  bool get _ok => _value != null && _reason.text.trim().length >= 3;

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Add to the ledger'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SegmentedButton<AdjustmentKind>(
                segments: [for (final k in AdjustmentKind.values) ButtonSegment(value: k, label: Text(k.label))],
                selected: {_kind},
                onSelectionChanged: (s) => setState(() => _kind = s.first),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('adjustment-amount'),
                controller: _amount,
                keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'^-?\d*\.?\d{0,2}'))],
                decoration: InputDecoration(
                  labelText: 'Amount (₹)',
                  helperText: _kind == AdjustmentKind.adjustment
                      ? 'Use a minus sign to take money off.'
                      : _kind == AdjustmentKind.deduction
                          ? 'Taken off what the rider is owed.'
                          : 'Added to what the rider is owed.',
                ),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(child: Text('Effective ${ymd(_date)}')),
                  TextButton(
                    onPressed: () async {
                      final now = DateTime.now();
                      final d = await showDatePicker(
                        context: context,
                        initialDate: _date,
                        firstDate: DateTime(now.year - 1),
                        lastDate: now,
                      );
                      if (d != null) setState(() => _date = d);
                    },
                    child: const Text('Change'),
                  ),
                ],
              ),
              TextField(
                key: const Key('adjustment-reason'),
                controller: _reason,
                maxLength: 300,
                decoration: const InputDecoration(labelText: 'Reason'),
                onChanged: (_) => setState(() {}),
              ),
              Wrap(
                spacing: 6,
                children: [
                  for (final p in RiderPicks.adjustment)
                    ActionChip(
                      label: Text(p),
                      onPressed: () => setState(() => _reason.text = p),
                    ),
                ],
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Back')),
          FilledButton(
            onPressed: _ok
                ? () {
                    final v = _value!;
                    // Rider plan (0083): bonus and deduction amounts are
                    // positive — the server subtracts a deduction; only an
                    // adjustment carries its own sign.
                    final amount = _kind == AdjustmentKind.adjustment ? v : v.abs();
                    Navigator.pop(
                      context,
                      AddRiderAdjustment(kind: _kind, amount: amount, effectiveOn: _date, reason: _reason.text.trim()),
                    );
                  }
                : null,
            child: const Text('Record'),
          ),
        ],
      );
}
