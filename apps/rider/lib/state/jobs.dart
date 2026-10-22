import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api.dart';
import '../core/ring.dart';
import '../models/jobs.dart';
import 'availability.dart';
import 'clock.dart';
import 'providers.dart';

/// What the Jobs tab knows: the last board the server sent, and how the
/// latest ask went.
@immutable
class BoardState {
  const BoardState({this.board, this.error, this.fromCache = false});

  /// The newest board we have; null until the first answer.
  final RiderBoard? board;

  /// Why the latest ask failed; null when it worked.
  final Object? error;

  /// [board] is only the delivery kept on the phone, because the server could
  /// not be reached.
  final bool fromCache;

  /// The first ask is still on its way.
  bool get loading => board == null && error == null;

  /// There is something to show, but the latest ask did not work, so it may be
  /// out of date.
  bool get stale => board != null && error != null;
}

/// `GET /api/rider/board`, asked again by the Jobs tab every 5 s while it is
/// showing and when the app comes back. On the way it keeps the delivery the
/// rider is carrying on the phone (for a lost signal), sends what is waiting in
/// the action queue, and lets the open board ring for a held offer.
class BoardNotifier extends Notifier<BoardState> {
  Future<void>? _inFlight;

  @override
  BoardState build() {
    Future.microtask(() {
      if (ref.mounted) refresh();
    });
    return const BoardState();
  }

  /// Asks the server. A call while one is already out shares it, unless
  /// [afterAction] is set: the answer to an accept or reject has to come from
  /// a request that started after it.
  Future<void> refresh({bool afterAction = false}) {
    final running = _inFlight;
    if (running != null) {
      return afterAction ? running.then((_) => refresh(afterAction: true)) : running;
    }
    final run = _load().whenComplete(() => _inFlight = null);
    _inFlight = run;
    return run;
  }

  Future<void> _load() async {
    final repo = ref.read(jobsRepoProvider);
    final RiderBoard board;
    try {
      board = await repo.board();
    } catch (e) {
      if (!ref.mounted) return;
      // A dropped signal mid-delivery must not lose the delivery screen.
      if (state.board == null && e is ApiException && e.transient) {
        final kept = ref.read(activeCacheProvider).load();
        if (kept != null) {
          state = BoardState(board: RiderBoard(active: kept), error: e, fromCache: true);
          return;
        }
      }
      state = BoardState(board: state.board, error: e, fromCache: state.fromCache);
      return;
    }
    if (!ref.mounted) return;
    // The gap between the server's clock and the phone's, as of this answer.
    final serverNow = board.serverNow;
    if (serverNow != null) {
      ref.read(serverOffsetProvider.notifier).set(serverNow.difference(ref.read(clockProvider)()));
    }
    state = BoardState(board: board);

    final cache = ref.read(activeCacheProvider);
    final active = board.active;
    if (active != null) {
      unawaited(cache.save(active));
    } else {
      unawaited(cache.clear());
    }
    final queue = ref.read(actionQueueProvider);
    if (queue.current.isNotEmpty) unawaited(queue.flush());
    // An offline rider is not rung for: an empty board stops anything ringing.
    final offline = phaseOf(ref.read(availabilityProvider), ref.read(clockProvider)()) == RiderPhase.offline;
    unawaited(ref.read(boardRingerProvider.notifier).sync(offline ? const RiderBoard() : board));
  }

  /// Takes an offer. The ring for it ends as soon as the server says yes, the
  /// board is asked again so it shows the delivery, and the rider's status is
  /// re-read (the location service reports faster on a delivery). A refusal
  /// asks the board too, so the card shows what is true now, and is rethrown
  /// for the screen to explain.
  Future<void> accept(String orderId) async {
    try {
      await ref.read(jobsRepoProvider).accept(orderId);
    } catch (e) {
      if (e is ApiException && !e.transient) await refresh(afterAction: true);
      rethrow;
    }
    await ref.read(boardRingerProvider.notifier).answered(orderId);
    ref.invalidate(meProvider);
    await refresh(afterAction: true);
  }

  /// Turns an offer down with one of the server's reasons.
  Future<void> reject(String orderId, String reason, {String? note}) async {
    try {
      await ref.read(jobsRepoProvider).reject(orderId, reason, note: note);
    } catch (e) {
      if (e is ApiException && !e.transient) await refresh(afterAction: true);
      rethrow;
    }
    await ref.read(boardRingerProvider.notifier).answered(orderId);
    await refresh(afterAction: true);
  }
}

final boardProvider = NotifierProvider<BoardNotifier, BoardState>(BoardNotifier.new);
