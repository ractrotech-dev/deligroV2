import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../data/jobs_repository.dart';
import '../models/queued_action.dart';
import 'active_cache.dart';
import 'api.dart';

export '../models/queued_action.dart';

/// The proof upload's refusals of the photo itself: retaking it is the fix,
/// sending it again is not.
const proofRefusals = {'bad_type', 'too_large', 'invalid_body'};

/// The delivery steps the rider has tapped, held until the server has them.
///
/// A rider in a lift or a lane with no signal must still be able to mark
/// "arrived" or "delivered": the tap is written here first (prefs
/// `action_queue_v1`, so it survives the app being killed) and sent from
/// there. The rules:
///
///  * Order is kept per order id: an action is never sent before the one
///    queued ahead of it for the same order. Different orders do not wait for
///    each other.
///  * Each action carries a UUID, so resending after a lost answer is safe: the
///    server answers `duplicate`, which counts as done.
///  * No connection, a 5xx, a session that needs refreshing: keep it queued.
///    429 `rate_limited`: keep everything queued and send nothing until the
///    server's retry-after has passed.
///  * A refusal on replay (`bad_otp`, `bad_state`, …) removes that one action
///    and is reported as `rejected(code)`; the rest of the order's queue goes on.
///  * `order_not_active` (or a delivery that is no longer theirs) means the job
///    is over: every action queued for it is dropped and the cached active
///    delivery is cleared. So does a `deliver` that went through.
///  * A `deliver` saved with no signal can carry its proof photo as a file on
///    the phone ([QueuedAction.localPhoto]): it is uploaded first, the server's
///    path is saved with the step (a restart does not upload it again), then
///    the step is sent. No signal for the upload keeps the step queued; a photo
///    the server will not take (`bad_type`, `too_large`) is `rejected(code)`.
///    The file is deleted once the step has left the queue.
///
/// Callers `flush()` when connectivity returns and on every board refresh.
class ActionQueue {
  ActionQueue(this._repo, this._prefs, this._cache, {DateTime Function()? clock})
      : _clock = clock ?? DateTime.now {
    _items = _load();
  }

  static const key = 'action_queue_v1';

  final JobsRepository _repo;
  final SharedPreferences _prefs;
  final ActiveDeliveryCache _cache;
  final DateTime Function() _clock;

  late List<QueuedAction> _items;
  final _changes = StreamController<List<QueuedAction>>.broadcast();
  final _outcomes = StreamController<ActionOutcome>.broadcast();
  Future<void> _lock = Future.value();
  DateTime? _backoffUntil;

  /// What is waiting right now, oldest first.
  List<QueuedAction> get current => List.unmodifiable(_items);

  /// The waiting actions: the current list first, then a new list on every
  /// change.
  Stream<List<QueuedAction>> get pending async* {
    yield current;
    yield* _changes.stream;
  }

  /// Every answer the server gave, from [submit] and [flush] alike: how a
  /// screen hears that a step it saved offline went through, or was refused,
  /// when the board refresh sent it.
  Stream<ActionOutcome> get outcomes => _outcomes.stream;

  /// Submits still waiting for their answer, by action id.
  final _submitting = <String, Future<ActionOutcome>>{};

  /// Sends [a] now, behind anything already queued for its order. Returns what
  /// came of it: `queued` when it could not be sent yet. The same tap
  /// submitted again while the first is still waiting shares its answer
  /// rather than going out a second time.
  Future<ActionOutcome> submit(QueuedAction a) {
    final waiting = _submitting[a.actionId];
    if (waiting != null) return waiting;
    final run = _submit(a);
    _submitting[a.actionId] = run;
    run.then((_) {}, onError: (_) {}).whenComplete(() => _submitting.remove(a.actionId));
    return run;
  }

  Future<ActionOutcome> _submit(QueuedAction a) => _locked(() async {
        if (_items.any((q) => q.actionId == a.actionId)) {
          return ActionOutcome(ActionOutcomeKind.queued, actionId: a.actionId, orderId: a.orderId);
        }
        // Written before it is sent: if the app dies mid-request the tap is
        // still here, and the server's duplicate answer makes the resend safe.
        _items.add(a);
        await _store();
        final outcomes = await _drain(only: a.orderId);
        return outcomes.firstWhere(
          (o) => o.actionId == a.actionId,
          orElse: () => ActionOutcome(ActionOutcomeKind.queued, actionId: a.actionId, orderId: a.orderId),
        );
      });

  /// Tries everything that is waiting. Returns an outcome per action the server
  /// answered (applied, duplicate, rejected, orderGone); actions it could not
  /// reach stay queued and are not listed.
  Future<List<ActionOutcome>> flush() => _locked(_drain);

  void dispose() {
    _changes.close();
    _outcomes.close();
  }

  void _report(List<ActionOutcome> outcomes, ActionOutcome o) {
    outcomes.add(o);
    if (!_outcomes.isClosed) _outcomes.add(o);
  }

  Future<T> _locked<T>(Future<T> Function() fn) {
    final run = _lock.then((_) => fn());
    _lock = run.then((_) {}, onError: (_) {});
    return run;
  }

  bool get _backingOff {
    final until = _backoffUntil;
    return until != null && _clock().isBefore(until);
  }

  Future<List<ActionOutcome>> _drain({String? only}) async {
    final outcomes = <ActionOutcome>[];
    if (_backingOff) return outcomes;

    final orders = <String>[
      for (final id in {..._items.map((a) => a.orderId)})
        if (only == null || id == only) id,
    ];
    for (final orderId in orders) {
      while (true) {
        final first = _items.where((a) => a.orderId == orderId).firstOrNull;
        if (first == null) break;
        var next = first;

        ActionOutcome outcome;
        try {
          if (next.needsUpload) {
            final ready = await _uploadPhoto(next);
            if (ready is ActionOutcome) {
              outcome = ready;
            } else {
              next = ready as QueuedAction;
              outcome = await _repo.act(next);
            }
          } else {
            outcome = await _repo.act(next);
          }
        } on ApiException catch (e) {
          if (e.status == 429 || e.code == 'rate_limited') {
            _backoffUntil = _clock().add(_retryAfter(e));
            return outcomes;
          }
          // No connection: the rest would only wait out the same timeout.
          if (e.status == 0) return outcomes;
          break; // 5xx, 401, …: keep this order's queue, try the others.
        } catch (e) {
          debugPrint('action queue: ${next.action} not sent: $e');
          break;
        }

        final sent = next;
        switch (outcome.kind) {
          case ActionOutcomeKind.applied:
          case ActionOutcomeKind.duplicate:
          case ActionOutcomeKind.rejected:
            _items.removeWhere((a) => a.actionId == sent.actionId);
            await _store();
            _discardPhoto(sent);
            // Delivered: the job is over, so is the copy kept for no signal.
            if (outcome.done && sent.action == 'deliver' && _cache.load()?.orderId == orderId) {
              await _cache.clear();
            }
            _report(
              outcomes,
              ActionOutcome(outcome.kind,
                  actionId: sent.actionId, orderId: orderId, code: outcome.code, action: sent.action),
            );
            continue;
          case ActionOutcomeKind.orderGone:
            final dropped = _items.where((a) => a.orderId == orderId).toList();
            _items.removeWhere((a) => a.orderId == orderId);
            await _store();
            if (_cache.load()?.orderId == orderId) await _cache.clear();
            for (final a in dropped) {
              _discardPhoto(a);
              _report(
                outcomes,
                ActionOutcome(
                  ActionOutcomeKind.orderGone,
                  actionId: a.actionId,
                  orderId: orderId,
                  code: a.actionId == sent.actionId ? outcome.code : null,
                  action: a.action,
                ),
              );
            }
          case ActionOutcomeKind.queued:
            break;
        }
        break;
      }
    }
    return outcomes;
  }

  /// Uploads the photo [a] carries. Returns the step ready to send (with the
  /// server's path, saved), or the server's verdict on it. Throws for "try
  /// again" answers, which keep it queued like any unsent step.
  Future<Object> _uploadPhoto(QueuedAction a) async {
    final String path;
    try {
      path = await _repo.uploadProof(a.orderId, File(a.localPhoto!));
    } on FileSystemException {
      return ActionOutcome(ActionOutcomeKind.rejected, actionId: a.actionId, orderId: a.orderId, code: 'invalid_photo');
    } on ApiException catch (e) {
      if (e.status == 404 && e.code == 'not_found') {
        return ActionOutcome(ActionOutcomeKind.orderGone, actionId: a.actionId, orderId: a.orderId, code: e.code);
      }
      if (proofRefusals.contains(e.code)) {
        return ActionOutcome(ActionOutcomeKind.rejected, actionId: a.actionId, orderId: a.orderId, code: e.code);
      }
      // The delivery is not where a photo can go (cancelled, already done):
      // the step goes without it and the server's answer to it says which.
      if (e.code == 'bad_state') return a;
      rethrow;
    }
    final ready = a.withPhotoPath(path);
    final i = _items.indexWhere((q) => q.actionId == a.actionId);
    if (i >= 0) {
      _items[i] = ready;
      await _store();
    }
    return ready;
  }

  /// Deletes the kept copy of a step's photo. Not waited on: tidying up must
  /// not hold the next step back (a file already gone is fine).
  void _discardPhoto(QueuedAction a) {
    final path = a.localPhoto;
    if (path == null) return;
    unawaited(File(path).delete().then((_) {}, onError: (_) {}));
  }

  Duration _retryAfter(ApiException e) {
    final secs = e.body['retryAfter'];
    return Duration(seconds: (secs is num ? secs.toInt() : 30).clamp(5, 120));
  }

  Future<void> _store() async {
    await _prefs.setString(key, jsonEncode(_items.map((a) => a.toJson()).toList()));
    if (!_changes.isClosed) _changes.add(current);
  }

  /// What was stored. An item that cannot be read is skipped on its own: one
  /// bad entry must not lose the rider's other saved steps.
  List<QueuedAction> _load() {
    final raw = _prefs.getString(key);
    if (raw == null) return [];
    final Object? list;
    try {
      list = jsonDecode(raw);
    } catch (_) {
      return [];
    }
    if (list is! List) return [];
    final items = <QueuedAction>[];
    for (final j in list) {
      try {
        items.add(QueuedAction.fromJson(Map<String, dynamic>.from(j as Map)));
      } catch (e) {
        debugPrint('action queue: skipped an unreadable saved step: $e');
      }
    }
    return items;
  }
}
