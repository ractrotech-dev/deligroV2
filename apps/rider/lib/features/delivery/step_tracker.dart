import 'package:flutter/material.dart';

import '../../models/jobs.dart';
import '../../theme/app_theme.dart';

/// One step of the tracker: the delivery's own statuses plus "Assigned", the
/// moment the job became the rider's.
typedef _Step = ({String wire, String label});

const _steps = <_Step>[
  (wire: 'assigned', label: 'Assigned'),
  (wire: 'accepted', label: 'Accepted'),
  (wire: 'arrived_pickup', label: 'Arrived at pickup'),
  (wire: 'picked_up', label: 'Picked up'),
  (wire: 'on_the_way', label: 'On the way'),
  (wire: 'arrived_drop', label: 'Arrived at customer'),
  (wire: 'delivered', label: 'Delivered'),
  (wire: 'failed', label: 'Failed'),
  (wire: 'cancelled', label: 'Cancelled'),
];

/// All nine statuses in a row the rider can glance at: done ones ticked, the
/// current one filled, the two ways a delivery can end badly at the end.
/// Scrolls itself so the current step is in view.
class StepTracker extends StatefulWidget {
  const StepTracker({super.key, required this.status});

  final RiderDeliveryStatus status;

  @override
  State<StepTracker> createState() => _StepTrackerState();
}

class _StepTrackerState extends State<StepTracker> {
  final _current = GlobalKey();

  @override
  void initState() {
    super.initState();
    _reveal();
  }

  @override
  void didUpdateWidget(covariant StepTracker old) {
    super.didUpdateWidget(old);
    if (old.status != widget.status) _reveal();
  }

  void _reveal() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final ctx = _current.currentContext;
      if (ctx == null || !mounted) return;
      // Only the tracker's own row scrolls; the page stays where it is.
      final box = ctx.findRenderObject();
      if (box == null) return;
      Scrollable.of(ctx).position.ensureVisible(
            box,
            alignment: 0.5,
            duration: const Duration(milliseconds: 250),
          );
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final current = widget.status;
    final ended = current == RiderDeliveryStatus.failed || current == RiderDeliveryStatus.cancelled;
    // Index in [_steps] of the current status; "assigned" is always behind.
    final at = _steps.indexWhere((s) => s.wire == current.wire);
    // How far the happy path got: a failure or cancellation leaves the rest
    // of it undone.
    final reached = ended ? _reachedBefore(current) : at;

    return SingleChildScrollView(
      key: const Key('step-tracker'),
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          for (var i = 0; i < _steps.length; i++) ...[
            if (i > 0) _Joint(done: i <= reached && i < 7, color: c.green, idle: c.line),
            _Pill(
              key: i == at ? _current : null,
              step: _steps[i],
              state: i == at
                  ? (ended ? _PillState.bad : _PillState.current)
                  : (i < 7 && i <= reached ? _PillState.done : _PillState.todo),
            ),
          ],
        ],
      ),
    );
  }

  /// A failed delivery got as far as the door; a cancelled one is not known.
  static int _reachedBefore(RiderDeliveryStatus s) => s == RiderDeliveryStatus.failed ? 5 : 1;
}

enum _PillState { done, current, bad, todo }

class _Pill extends StatelessWidget {
  const _Pill({super.key, required this.step, required this.state});

  final _Step step;
  final _PillState state;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (bg, fg, border, icon) = switch (state) {
      _PillState.done => (c.greenSoft, c.green, c.greenSoft, Icons.check_rounded),
      _PillState.current => (c.accent, c.onAccent, c.accent, Icons.radio_button_checked_rounded),
      _PillState.bad => (c.deal, c.onDeal, c.deal, Icons.close_rounded),
      _PillState.todo => (c.surface, c.muted, c.line, null),
    };
    final current = state == _PillState.current || state == _PillState.bad;
    return Semantics(
      selected: current,
      label: current ? 'Current step: ${step.label}' : step.label,
      excludeSemantics: true,
      child: Container(
        key: current ? Key('step-current-${step.wire}') : Key('step-${step.wire}'),
        padding: EdgeInsets.symmetric(horizontal: current ? 12 : 10, vertical: current ? 8 : 6),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: border, width: 1.4),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: current ? 16 : 14, color: fg),
              const SizedBox(width: 5),
            ],
            Text(
              step.label,
              style: TextStyle(
                color: fg,
                fontSize: current ? 14 : 12.5,
                fontWeight: current ? FontWeight.w800 : FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Joint extends StatelessWidget {
  const _Joint({required this.done, required this.color, required this.idle});

  final bool done;
  final Color color;
  final Color idle;

  @override
  Widget build(BuildContext context) => Container(
        width: 14,
        height: 2,
        margin: const EdgeInsets.symmetric(horizontal: 2),
        color: done ? color : idle,
      );
}
