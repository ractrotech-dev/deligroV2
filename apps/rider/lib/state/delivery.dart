import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/jobs.dart';
import '../models/queued_action.dart';
import 'jobs.dart';
import 'providers.dart';

/// How a delivery the rider was carrying came to an end, as far as the phone
/// can tell.
enum DeliveryEnd {
  /// The rider delivered it (the deliver step went through).
  delivered,

  /// Ops approved "complete without the code", which completes it for them.
  completedByOps,

  /// Ops approved a failure (unreachable, wrong address, failed delivery).
  failed,

  /// Ops approved going offline: the order went back to dispatch.
  handedBack,

  /// It left the board for a reason the phone does not know: cancelled, or
  /// given to another rider (`order_not_active`).
  gone,
}

@immutable
class FinishedDelivery {
  const FinishedDelivery(this.active, DeliveryEnd this.end);

  /// The board has dropped [active] while steps for it were still waiting to
  /// be sent: the screen keeps showing it, live, until the queue's answer for
  /// them says how it ended.
  const FinishedDelivery.waiting(this.active) : end = null;

  final RiderActive active;

  /// Null while [waiting].
  final DeliveryEnd? end;

  bool get waiting => end == null;
}

/// What a delivery that just left the board most likely became, from the
/// requests the rider had raised on it.
DeliveryEnd endFromRequests(RiderActive a) {
  bool asked(Set<String> kinds) =>
      a.exceptions.any((e) => kinds.contains(e.kind) && (e.status == 'pending' || e.status == 'approved'));
  if (asked(const {'complete_without_code'})) return DeliveryEnd.completedByOps;
  if (asked(const {'failed_delivery', 'customer_unreachable', 'wrong_address'})) return DeliveryEnd.failed;
  if (asked(const {'go_offline'})) return DeliveryEnd.handedBack;
  return DeliveryEnd.gone;
}

/// The delivery the screen keeps showing after it has left the board, so the
/// rider sees how it ended ("Delivered", "no longer yours") instead of the
/// screen silently turning into the offers list. Cleared by "Back to jobs".
///
/// The board lists a delivery only while the order is assigned or picked up,
/// so a delivery ops cancelled while the rider had steps saved offline just
/// vanishes from it. Those steps' answers decide then: the notifier holds the
/// delivery as [FinishedDelivery.waiting] (the screen stays) and listens to
/// the queue itself, so the answer is heard even with no screen listening.
class FinishedDeliveryNotifier extends Notifier<FinishedDelivery?> {
  @override
  FinishedDelivery? build() {
    // Another user on this phone: the last rider's delivery is not theirs to
    // see, finished or not.
    ref.watch(riderKeyProvider);
    ref.listen(boardProvider, (prev, next) {
      final board = next.board;
      // Only a real answer from the server says the delivery is gone.
      if (board == null || next.error != null || next.fromCache) return;
      final cur = state;
      if (cur != null && cur.waiting) {
        if (board.active != null) {
          // Still theirs after all, or a new job: the board's word again.
          state = null;
        } else if (!_queuedFor(cur.active.orderId)) {
          state = FinishedDelivery(cur.active, endFromRequests(cur.active));
        }
        return;
      }
      final was = prev?.board?.active;
      if (was == null || !was.status.live || board.active != null) return;
      if (cur != null) return;
      // A step for it is still waiting to be sent: its answer decides.
      state = _queuedFor(was.orderId) ? FinishedDelivery.waiting(was) : FinishedDelivery(was, endFromRequests(was));
    });
    final outcomes = ref.read(actionQueueProvider).outcomes.listen(_onOutcome);
    ref.onDispose(outcomes.cancel);
    return null;
  }

  bool _queuedFor(String orderId) => ref.read(actionQueueProvider).current.any((a) => a.orderId == orderId);

  void _onOutcome(ActionOutcome o) {
    final cur = state;
    if (cur == null || !cur.waiting || o.orderId != cur.active.orderId) return;
    if (o.kind == ActionOutcomeKind.orderGone) {
      state = FinishedDelivery(cur.active, DeliveryEnd.gone);
    } else if (o.done && o.action == 'deliver') {
      state = FinishedDelivery(cur.active, DeliveryEnd.delivered);
    } else if (!_queuedFor(cur.active.orderId)) {
      // Another step went through (or was refused): the board, asked again,
      // says whether the delivery is still theirs.
      unawaited(ref.read(boardProvider.notifier).refresh(afterAction: true));
    }
  }

  void finish(RiderActive a, DeliveryEnd end) => state = FinishedDelivery(a, end);

  void clear() => state = null;
}

final finishedDeliveryProvider =
    NotifierProvider<FinishedDeliveryNotifier, FinishedDelivery?>(FinishedDeliveryNotifier.new);

/// The status each step moves a delivery to.
const actionTargets = <String, RiderDeliveryStatus>{
  'arrive_pickup': RiderDeliveryStatus.arrivedPickup,
  'pickup': RiderDeliveryStatus.pickedUp,
  'start_trip': RiderDeliveryStatus.onTheWay,
  'arrive_drop': RiderDeliveryStatus.arrivedDrop,
  'deliver': RiderDeliveryStatus.delivered,
};

/// The status the screen works from: the board's, moved on by the steps the
/// rider has already taken that the board does not show yet (saved offline,
/// or sent but the board not asked again). A delivery the board says is over
/// stays over.
RiderDeliveryStatus effectiveStatus(
  RiderActive a,
  Iterable<QueuedAction> waiting, {
  RiderDeliveryStatus? applied,
}) {
  if (!a.status.live) return a.status;
  var s = a.status;
  void lift(RiderDeliveryStatus? t) {
    if (t != null && t.index > s.index) s = t;
  }

  for (final q in waiting) {
    if (q.orderId == a.orderId) lift(actionTargets[q.action]);
  }
  lift(applied);
  return s;
}

/// Calls to the customer the server has logged, by order id: what "customer
/// unreachable" waits on until the next board shows the call.
class CustomerCallsNotifier extends Notifier<Map<String, DateTime>> {
  @override
  Map<String, DateTime> build() {
    ref.watch(riderKeyProvider); // one rider's calls
    return const {};
  }

  void called(String orderId, DateTime at) => state = {...state, orderId: at};
}

final customerCallsProvider =
    NotifierProvider<CustomerCallsNotifier, Map<String, DateTime>>(CustomerCallsNotifier.new);

/// Why "customer unreachable" cannot be asked yet, if it cannot.
@immutable
class UnreachableGate {
  const UnreachableGate({required this.arrived, required this.called, required this.waitLeft});

  /// The server has the arrival at the door.
  final bool arrived;

  /// A call to the customer was logged since arriving.
  final bool called;

  /// Time still to wait at the door (zero or less: done).
  final Duration waitLeft;

  bool get open => arrived && called && waitLeft <= Duration.zero;

  /// What the rider still has to do, in words; null when it is open.
  String? why() {
    if (!arrived) return "Waiting for your arrival to reach Deligro";
    final wait = waitLeft > Duration.zero ? clock(waitLeft) : null;
    if (!called && wait != null) return 'Call the customer first, then wait $wait';
    if (!called) return 'Call the customer first';
    if (wait != null) return 'Wait at the door — available in $wait';
    return null;
  }

  /// `m:ss`, rounded up so it never shows 0:00 while still closed.
  static String clock(Duration d) {
    final secs = (d.inMilliseconds / 1000).ceil();
    return '${secs ~/ 60}:${(secs % 60).toString().padLeft(2, '0')}';
  }
}

/// The server's rule (exception-rules.ts): arrived at the door, a logged call
/// to the customer since, and `unreachableWaitMinutes` waited.
UnreachableGate unreachableGate(RiderActive a, {required DateTime now, DateTime? localCall}) {
  final arrivedAt = a.arrivedDropAt;
  if (arrivedAt == null) {
    return UnreachableGate(arrived: false, called: localCall != null, waitLeft: Duration.zero);
  }
  final logged = a.timeline.any(
    (e) => e.kind == 'contact_attempt' && e.method == 'customer' && !e.at.isBefore(arrivedAt),
  );
  final waitLeft = arrivedAt.add(Duration(minutes: a.unreachableWaitMinutes)).difference(now);
  return UnreachableGate(arrived: true, called: logged || localCall != null, waitLeft: waitLeft);
}
