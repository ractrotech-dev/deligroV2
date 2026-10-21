import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../models/outcome.dart';
import '../../models/vendors.dart';
import '../../state/session.dart';
import '../../state/vendors.dart';
import '../../widgets/async_view.dart';
import '../orders/reason_dialog.dart';

/// Quick picks for each vendor decision; the manager can still edit them.
abstract final class VendorPicks {
  static const approve = ['Documents verified', 'Store inspected'];
  static const reject = ['Documents invalid', 'Outside service area', 'Duplicate registration'];
  static const suspend = ['Hygiene complaint', 'Repeated cancellations', 'Pending dues', 'Owner request'];
  static const reactivate = ['Issue resolved', 'Owner request'];
  static const verifyDocument = ['Checked against the original', 'Details match the registration'];
  static const rejectDocument = ['Blurry or unreadable', 'Expired', 'Name does not match', 'Wrong document'];
}

/// What a refusal means, in words.
String vendorRefusalText(Refused<Object?> r) => switch (r.code) {
      'stale' => 'Someone else changed this vendor. Showing the latest.',
      'invalid_transition' => "That change doesn't apply to this vendor any more.",
      'needs_map_pin' => 'Pin the shop on the map first (Admin → Vendors → Edit).',
      'documents_unverified' => 'Required documents are not verified.',
      'reason_required' => 'Please give a reason of at least 3 characters.',
      'permission_denied' || 'forbidden' => "You don't have permission for that. Ask an admin.",
      'not_found' => "This vendor isn't in your zones.",
      'rate_limited' => 'Too many changes at once. Wait a moment and try again.',
      _ => "That didn't go through (${r.code}).",
    };

/// The status decisions, in the order the header shows them.
enum VendorDecision {
  approve('Approve', 'Approve this vendor?', VendorPicks.approve, 'approved'),
  reject('Reject', 'Reject this registration?', VendorPicks.reject, 'rejected'),
  suspend('Suspend', 'Suspend this vendor?', VendorPicks.suspend, 'suspended'),
  reactivate('Reactivate', 'Reactivate this vendor?', VendorPicks.reactivate, 'reactivated');

  const VendorDecision(this.label, this.title, this.picks, this.done);
  final String label;
  final String title;
  final List<String> picks;
  final String done;

  bool allowedBy(VendorAllowed a) => switch (this) {
        approve => a.approve,
        reject => a.reject,
        suspend => a.suspend,
        reactivate => a.reactivate,
      };

  VendorAction action(VendorStatus expected, String reason) => switch (this) {
        approve => ApproveVendor(expected: expected, reason: reason),
        reject => RejectVendor(expected: expected, reason: reason),
        suspend => SuspendVendor(expected: expected, reason: reason),
        reactivate => ReactivateVendor(expected: expected, reason: reason),
      };
}

/// Asks why, then sends [decision] for [vendor], handling every answer the
/// server can give. Suspension says what it does before it is sent.
Future<void> decideVendor(BuildContext context, WidgetRef ref, VendorDetail vendor, VendorDecision decision) async {
  final reason = await showReasonDialog(
    context,
    title: decision.title,
    quickPicks: decision.picks,
    submitLabel: decision.label,
    message: decision == VendorDecision.suspend
        ? 'The shop leaves the storefront at once. Orders already in progress carry on.'
        : null,
  );
  if (reason == null || !context.mounted) return;
  await sendVendorAction(context, ref, vendor.id, decision.action(vendor.status, reason), doneText: 'Vendor ${decision.done}.');
}

/// Sends [action]. A network or server fault offers Retry with the same
/// action (same `clientActionId`); a refusal is explained, and an approval
/// refused for unverified documents offers "Approve anyway".
Future<void> sendVendorAction(
  BuildContext context,
  WidgetRef ref,
  String vendorId,
  VendorAction action, {
  required String doneText,
}) async {
  final notifier = ref.read(vendorDetailProvider(vendorId).notifier);
  final Outcome<VendorDetail> out;
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
          onPressed: () => sendVendorAction(context, ref, vendorId, action, doneText: doneText),
        ),
      ));
    return;
  }
  if (!context.mounted) return;
  switch (out) {
    case Applied():
      showSnack(context, doneText);
    case Refused(code: 'documents_unverified', :final reasons) when action is ApproveVendor:
      final missing = [for (final r in reasons) '${DocType.parse(r).label} not verified'];
      final go = await confirm(
        context,
        title: 'Documents not verified',
        message: [
          ...missing.isEmpty ? ['Required documents are not verified.'] : missing,
          '',
          'Approving anyway is recorded in the audit log.',
        ].join('\n'),
        yes: 'Approve anyway',
      );
      if (go && context.mounted) {
        await sendVendorAction(context, ref, vendorId, action.anyway(), doneText: doneText);
      }
    case Refused():
      showSnack(context, vendorRefusalText(out));
  }
}
