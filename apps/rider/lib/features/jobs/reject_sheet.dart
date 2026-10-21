import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';

/// Why a rider turns an offer down: the five reasons the server accepts
/// (`REJECT_REASONS` in src/lib/rider/offer-window.ts), in the order they are
/// shown. [wire] is what is sent.
enum RejectReason {
  tooFar('too_far', 'Too far', Icons.social_distance_rounded),
  vehicleIssue('vehicle_issue', 'Vehicle issue', Icons.two_wheeler_rounded),
  onBreak('on_break', 'On a break', Icons.free_breakfast_outlined),
  lowBattery('low_battery', 'Low battery', Icons.battery_alert_rounded),
  other('other', 'Other', Icons.more_horiz_rounded);

  const RejectReason(this.wire, this.label, this.icon);

  final String wire;
  final String label;
  final IconData icon;
}

typedef RejectChoice = ({RejectReason reason, String? note});

/// The longest note the server keeps.
const rejectNoteMax = 200;

/// Asks which reason, and for "Other" an optional note. Null if the rider
/// backs out; Send stays off until a reason is chosen.
Future<RejectChoice?> showRejectSheet(BuildContext context) => showModalBottomSheet<RejectChoice>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      builder: (_) => const _RejectSheet(),
    );

class _RejectSheet extends StatefulWidget {
  const _RejectSheet();

  @override
  State<_RejectSheet> createState() => _RejectSheetState();
}

class _RejectSheetState extends State<_RejectSheet> {
  RejectReason? _reason;
  final _note = TextEditingController();

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  void _send() {
    final reason = _reason;
    if (reason == null) return;
    final note = _note.text.trim();
    Navigator.pop<RejectChoice>(context, (
      reason: reason,
      note: reason == RejectReason.other && note.isNotEmpty ? note : null,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 4),
                child: Text('Why are you turning this down?', style: Theme.of(context).textTheme.titleLarge),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
                child: Text('The order goes to the next rider.', style: TextStyle(color: c.muted)),
              ),
              for (final r in RejectReason.values)
                Semantics(
                  inMutuallyExclusiveGroup: true,
                  checked: _reason == r,
                  child: ListTile(
                    key: Key('reason-${r.wire}'),
                    minTileHeight: 56,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 24),
                    leading: Icon(r.icon, color: _reason == r ? c.accentInk : c.muted),
                    title: Text(
                      r.label,
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
                    ),
                    trailing: Icon(
                      _reason == r ? Icons.radio_button_checked_rounded : Icons.radio_button_off_rounded,
                      color: _reason == r ? c.accent : c.muted,
                    ),
                    selected: _reason == r,
                    selectedTileColor: c.accentSoft,
                    onTap: () => setState(() => _reason = r),
                  ),
                ),
              if (_reason == RejectReason.other)
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 8, 24, 0),
                  child: TextField(
                    key: const Key('reject-note'),
                    controller: _note,
                    maxLength: rejectNoteMax,
                    maxLines: 3,
                    minLines: 2,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: const InputDecoration(hintText: 'Tell us more (optional)'),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 12, 24, 12),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        key: const Key('reject-cancel'),
                        onPressed: () => Navigator.pop(context),
                        child: const Text('Cancel'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      flex: 2,
                      child: FilledButton(
                        key: const Key('reject-send'),
                        onPressed: _reason == null ? null : _send,
                        child: const Text('Send'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
