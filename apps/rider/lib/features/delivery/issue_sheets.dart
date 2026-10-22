import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import '../../core/api.dart';
import '../../state/delivery.dart';
import '../../theme/app_theme.dart';
import 'proof_photo.dart';

/// One kind of request or report the rider can raise (exception-rules.ts).
class IssueKind {
  const IssueKind(this.wire, this.title, this.blurb, this.icon, {this.reasons = const []});

  final String wire;
  final String title;
  final String blurb;
  final IconData icon;

  /// Quick reasons to pick from; empty means the rider writes one.
  final List<String> reasons;
}

const _kinds = <IssueKind>[
  IssueKind(
    'customer_unreachable',
    'Customer unreachable',
    'Deligro ops check and close the delivery. Stay near the door until they answer.',
    Icons.phone_disabled_rounded,
    reasons: ['No answer on calls', 'Phone switched off', 'Nobody at the door'],
  ),
  IssueKind(
    'wrong_address',
    'Wrong address',
    "Tell Deligro ops what you found. They'll call the customer or close the delivery.",
    Icons.wrong_location_rounded,
    reasons: ['Address not found', 'Customer not at this address', 'Place is closed or locked'],
  ),
  IssueKind(
    'complete_without_code',
    'Complete without the code',
    "Deligro ops can complete it if the customer has the food but can't give the code.",
    Icons.lock_open_rounded,
    reasons: ["Customer can't find the code", "Customer's phone is off", 'Handed to family or a guard'],
  ),
  IssueKind(
    'failed_delivery',
    'Failed delivery',
    "Deligro ops close the delivery. Take the food back to the shop.",
    Icons.cancel_outlined,
    reasons: ['Customer refused the order', 'Unsafe to deliver', 'Food damaged on the way', 'Vehicle broke down'],
  ),
  IssueKind(
    'go_offline',
    'Hand back this order',
    'Deligro ops give it to another rider and take you offline. Only before pickup.',
    Icons.power_settings_new_rounded,
    reasons: ['Vehicle problem', 'Feeling unwell', 'Family emergency'],
  ),
  IssueKind(
    'missing_items',
    'Missing items',
    'Deligro ops sort it out with the shop.',
    Icons.remove_shopping_cart_outlined,
    reasons: ['An item is missing', 'Wrong quantity packed'],
  ),
  IssueKind(
    'wrong_package',
    'Wrong package',
    "Don't take a package that isn't this order.",
    Icons.inventory_2_outlined,
    reasons: ['Different order handed over', 'Package damaged or open'],
  ),
  IssueKind(
    'vendor_delay',
    'Shop delay',
    'Deligro ops will know the food is running late.',
    Icons.hourglass_bottom_rounded,
    reasons: ['Food not ready yet', 'Shop is closed', 'Shop is very busy'],
  ),
  IssueKind('other_issue', 'Other problem', "Tell Deligro ops what's wrong.", Icons.help_outline_rounded),
  IssueKind(
    'manual_pickup',
    'Request manual check',
    'Deligro ops check the handover with the shop. Once they approve, confirm the pickup here.',
    Icons.fact_check_outlined,
    reasons: ["Shop can't find the code", "QR won't scan", "Shop's screen is off"],
  ),
];

IssueKind issueKind(String wire) => _kinds.firstWhere((k) => k.wire == wire);

/// At the shop, before pickup: reports about the order, and handing it back
/// (ruling P2-R9: going offline is allowed only before pickup).
const shopIssues = ['missing_items', 'wrong_package', 'vendor_delay', 'other_issue', 'go_offline'];

/// Carrying the food, on the way.
const roadIssues = ['wrong_address', 'failed_delivery', 'missing_items', 'wrong_package', 'other_issue'];

/// At the customer's door: "Can't deliver?".
const dropIssues = ['customer_unreachable', 'wrong_address', 'complete_without_code', 'failed_delivery', 'other_issue'];

/// A request's or report's state in words, for the card.
String issueStatusText(String status) => switch (status) {
      'pending' => 'Waiting for Deligro ops',
      'approved' => 'Approved',
      'rejected' => 'Not approved',
      'acknowledged' => 'Seen by Deligro ops',
      final other => other,
    };

/// What the rider filled in.
class IssueDraft {
  const IssueDraft({required this.reason, this.notes, this.photo});

  final String reason;
  final String? notes;
  final File? photo;
}

/// The server's refusals of `POST /api/rider/exceptions`, in words.
String issueErrorText(Object e) {
  if (e is! ApiException) return 'Something went wrong. Please try again.';
  return switch (e.code) {
    'call_first' => 'Call the customer first. Deligro ops need to see that you tried.',
    'wait_longer' => 'Wait ${e.body['minutesLeft'] ?? 'a few'} more min at the door, then try again.',
    'duplicate_pending' => "You've already asked. Deligro ops are looking at it.",
    'bad_state' => "This can't be asked at this step of the delivery.",
    'not_found' => 'This delivery is no longer yours.',
    'bad_photo' || 'invalid_photo_path' => 'Retake the photo and try again.',
    'migration_pending' => "Requests aren't available yet. Call Deligro support.",
    'network' => 'No connection. Requests need a signal — try again in a moment.',
    _ => e.transient ? 'No connection. Requests need a signal — try again in a moment.' : e.friendly,
  };
}

/// The list of problems for where the rider is; returns the kind chosen.
/// [unreachable] is asked every second while the sheet is open, so the
/// "customer unreachable" row counts down and unlocks by itself.
Future<String?> showIssueMenu(
  BuildContext context, {
  required String title,
  required List<String> kinds,
  UnreachableGate Function()? unreachable,
}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => _IssueMenu(title: title, kinds: kinds, unreachable: unreachable),
  );
}

class _IssueMenu extends StatefulWidget {
  const _IssueMenu({required this.title, required this.kinds, this.unreachable});

  final String title;
  final List<String> kinds;
  final UnreachableGate Function()? unreachable;

  @override
  State<_IssueMenu> createState() => _IssueMenuState();
}

class _IssueMenuState extends State<_IssueMenu> {
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    if (widget.unreachable != null && widget.kinds.contains('customer_unreachable')) {
      _tick = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final gate = widget.unreachable?.call();
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Text(widget.title, style: Theme.of(context).textTheme.titleLarge),
          ),
          for (final wire in widget.kinds)
            Builder(builder: (context) {
              final kind = issueKind(wire);
              final why = wire == 'customer_unreachable' ? gate?.why() : null;
              final enabled = why == null;
              return ListTile(
                key: Key('issue-$wire'),
                enabled: enabled,
                minVerticalPadding: 12,
                leading: Icon(kind.icon, color: enabled ? c.ink : c.muted, size: 28),
                title: Text(kind.title, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16.5)),
                subtitle: Text(
                  why ?? kind.blurb,
                  style: TextStyle(
                    color: why != null ? c.accentInk : c.muted,
                    fontWeight: why != null ? FontWeight.w700 : FontWeight.w500,
                  ),
                ),
                trailing: Icon(Icons.chevron_right_rounded, color: c.muted),
                onTap: enabled ? () => Navigator.of(context).pop(wire) : null,
              );
            }),
        ],
      ),
    );
  }
}

/// The form for one kind: a reason (picked, or written for "other"), notes
/// and an optional photo. [send] answers null when it went through (the sheet
/// closes and true is returned) or the refusal in words (the sheet stays).
Future<bool> showIssueSheet(
  BuildContext context, {
  required IssueKind kind,
  required PhotoTaker takePhoto,
  required Future<String?> Function(IssueDraft draft) send,
}) async {
  final sent = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (context) => _IssueSheet(kind: kind, takePhoto: takePhoto, send: send),
  );
  return sent ?? false;
}

class _IssueSheet extends StatefulWidget {
  const _IssueSheet({required this.kind, required this.takePhoto, required this.send});

  final IssueKind kind;
  final PhotoTaker takePhoto;
  final Future<String?> Function(IssueDraft draft) send;

  @override
  State<_IssueSheet> createState() => _IssueSheetState();
}

class _IssueSheetState extends State<_IssueSheet> {
  final _notes = TextEditingController();
  final _reasonText = TextEditingController();
  int? _picked;
  File? _photo;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reasonText.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _notes.dispose();
    _reasonText.dispose();
    super.dispose();
  }

  String? get _reason {
    final reasons = widget.kind.reasons;
    if (reasons.isEmpty) {
      final t = _reasonText.text.trim();
      return t.isEmpty ? null : t;
    }
    final i = _picked;
    return i == null ? null : reasons[i];
  }

  Future<void> _addPhoto() async {
    try {
      final f = await widget.takePhoto();
      if (f != null && mounted) setState(() => _photo = f);
    } catch (_) {
      if (mounted) setState(() => _error = "The camera didn't open. You can send without a photo.");
    }
  }

  Future<void> _send() async {
    final reason = _reason;
    if (reason == null || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final notes = _notes.text.trim();
    final error = await widget.send(IssueDraft(reason: reason, notes: notes.isEmpty ? null : notes, photo: _photo));
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop(true);
      return;
    }
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final kind = widget.kind;
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(kind.icon, size: 28, color: c.accentInk),
              const SizedBox(width: 10),
              Expanded(child: Text(kind.title, style: Theme.of(context).textTheme.titleLarge)),
            ],
          ),
          const SizedBox(height: 6),
          Text(kind.blurb, style: TextStyle(color: c.muted, fontSize: 15)),
          const SizedBox(height: 16),
          Text('WHAT HAPPENED', style: Theme.of(context).textTheme.labelSmall),
          const SizedBox(height: 8),
          if (kind.reasons.isEmpty)
            TextField(
              key: const Key('issue-reason-text'),
              controller: _reasonText,
              maxLength: 200,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(hintText: 'Say what is wrong', counterText: ''),
            )
          else
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (var i = 0; i < kind.reasons.length; i++)
                  ChoiceChip(
                    key: Key('issue-reason-$i'),
                    label: Text(kind.reasons[i]),
                    selected: _picked == i,
                    onSelected: _busy ? null : (_) => setState(() => _picked = i),
                    labelStyle: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700, color: c.ink),
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 8),
                  ),
              ],
            ),
          const SizedBox(height: 14),
          TextField(
            key: const Key('issue-notes'),
            controller: _notes,
            maxLength: 500,
            minLines: 2,
            maxLines: 4,
            textCapitalization: TextCapitalization.sentences,
            decoration: const InputDecoration(hintText: 'Notes for Deligro ops (optional)'),
          ),
          const SizedBox(height: 4),
          OutlinedButton.icon(
            key: const Key('issue-photo'),
            onPressed: _busy ? null : _addPhoto,
            icon: Icon(_photo == null ? Icons.add_a_photo_outlined : Icons.check_circle_rounded,
                color: _photo == null ? null : c.green),
            label: Text(_photo == null ? 'Add a photo (optional)' : 'Photo added — retake'),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Semantics(
              liveRegion: true,
              child: Text(
                _error!,
                key: const Key('issue-error'),
                style: TextStyle(color: c.deal, fontWeight: FontWeight.w800, fontSize: 15),
              ),
            ),
          ],
          const SizedBox(height: 14),
          FilledButton(
            key: const Key('issue-send'),
            onPressed: _reason == null || _busy ? null : _send,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
            child: _busy
                ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 3))
                : const Text('Send to Deligro ops'),
          ),
        ],
      ),
    );
  }
}
