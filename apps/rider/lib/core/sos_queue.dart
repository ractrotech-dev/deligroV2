import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import '../data/safety_repository.dart';
import '../models/support.dart';
import 'api.dart';

/// How often an alert that has not reached Deligro is tried again.
const sosRetryEvery = Duration(seconds: 15);

/// An alert older than this is not sent on its own: what was true an hour ago
/// (where the rider was, that they needed help) is not something to announce
/// to ops as if it were now. The rider is asked: send now, or discard.
const sosStaleAfter = Duration(minutes: 60);

/// A position older than this is not sent as the rider's location.
const sosPositionFresh = Duration(minutes: 2);

/// The longest an alert waits for a position before it goes without one.
const sosPositionWait = Duration(seconds: 5);

typedef SosPosition = ({double lat, double lng});

/// An "Alert Deligro" the server has not confirmed yet.
class QueuedSos {
  const QueuedSos({
    required this.id,
    required this.uid,
    this.lat,
    this.lng,
    this.positionAt,
    this.orderId,
    required this.queuedAt,
    this.approved = false,
  });

  factory QueuedSos.create({
    required String uid,
    double? lat,
    double? lng,
    String? orderId,
    required DateTime now,
  }) =>
      QueuedSos(
        id: const Uuid().v4(),
        uid: uid,
        lat: lat,
        lng: lng,
        positionAt: lat != null && lng != null ? now : null,
        orderId: orderId,
        queuedAt: now,
      );

  final String id;

  /// The signed-in user who pressed it. It is only ever sent under their
  /// session, and dropped when they sign out or another user signs in.
  final String uid;
  final double? lat;
  final double? lng;

  /// When [lat] / [lng] were read.
  final DateTime? positionAt;
  final String? orderId;
  final DateTime queuedAt;

  /// The rider chose "Send now" for an alert that had gone stale.
  final bool approved;

  QueuedSos approve() => QueuedSos(
        id: id,
        uid: uid,
        lat: lat,
        lng: lng,
        positionAt: positionAt,
        orderId: orderId,
        queuedAt: queuedAt,
        approved: true,
      );

  /// This alert with the position just read.
  QueuedSos withPosition(double lat, double lng, DateTime at) => QueuedSos(
        id: id,
        uid: uid,
        lat: lat,
        lng: lng,
        positionAt: at,
        orderId: orderId,
        queuedAt: queuedAt,
        approved: approved,
      );

  bool stale(DateTime now) => !approved && now.difference(queuedAt) > sosStaleAfter;

  /// The position it was pressed with, only while it is still current.
  SosPosition? freshPosition(DateTime now) {
    final at = positionAt;
    if (lat == null || lng == null || at == null) return null;
    return now.difference(at) <= sosPositionFresh ? (lat: lat!, lng: lng!) : null;
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'uid': uid,
        'lat': lat,
        'lng': lng,
        'positionAt': positionAt?.toUtc().toIso8601String(),
        'orderId': orderId,
        'queuedAt': queuedAt.toUtc().toIso8601String(),
        'approved': approved,
      };

  factory QueuedSos.fromJson(Map<String, dynamic> j) => QueuedSos(
        id: j['id'] as String,
        uid: j['uid'] as String,
        lat: (j['lat'] as num?)?.toDouble(),
        lng: (j['lng'] as num?)?.toDouble(),
        positionAt: DateTime.tryParse('${j['positionAt']}'),
        orderId: j['orderId'] as String?,
        queuedAt: DateTime.tryParse('${j['queuedAt']}') ?? DateTime.fromMillisecondsSinceEpoch(0),
        approved: j['approved'] == true,
      );
}

/// Where the rider's alert stands. The words the screens show for each phase
/// are in features/safety/sos_sheet.dart.
enum SosPhase {
  /// Nothing sent, nothing waiting.
  idle,

  /// A try is in flight.
  sending,

  /// The server has not confirmed: it is kept and tried again every 15 s.
  queued,

  /// The server confirmed (a 2xx). The only phase that may say ops were alerted.
  sent,

  /// The server refused it for good (a bad request); never retried.
  refused,

  /// An alert from over an hour ago, kept but not sent: the rider decides.
  stale,
}

class SosStatus {
  const SosStatus(this.phase, {this.ack, this.attempts = 0, this.needsSignIn = false});

  final SosPhase phase;
  final SosAck? ack;

  /// Tries made for the alert now waiting.
  final int attempts;

  /// The session was refused (401): nothing is retried until the same user
  /// signs in again.
  final bool needsSignIn;

  static const idle = SosStatus(SosPhase.idle);

  bool get pending => phase == SosPhase.sending || phase == SosPhase.queued;
}

/// "Alert Deligro" that survives having no signal.
///
/// The tap is written to the phone first (prefs `sos_queue_v1`, so it
/// survives the app being killed) and sent from there. Nothing here says
/// anything was sent until the server has answered 2xx:
///
///  * no connection, a 5xx, 429: keep it, try again every [retryEvery] (15 s)
///    with the rider's position as it is then (a position more than two
///    minutes old is never sent as current);
///  * 401: stop retrying until the same user signs in again ([userChanged]);
///  * a refusal (400): drop it and report [SosPhase.refused];
///  * every alert belongs to the user who pressed it: it is only sent while
///    they are signed in, and [userChanged] drops it on sign-out or when
///    another user signs in;
///  * an alert older than [sosStaleAfter] is not sent automatically
///    ([SosPhase.stale]): [sendNow] or [discard];
///  * a second tap while one is waiting replaces its position and tries at
///    once. The server folds taps within 10 minutes into one emergency, so a
///    resend after a lost answer only adds a location update.
///
/// It is its own small queue rather than a lane of the delivery
/// [ActionQueue]: an alert is not tied to an order, never waits behind a
/// delivery step, and has to keep retrying on a 15-second beat.
class SosQueue {
  SosQueue(
    this._repo,
    this._prefs, {
    required this.uid,
    this.retryEvery = sosRetryEvery,
    this.positionWait = sosPositionWait,
    this.position,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now {
    _items = _load();
    // Nothing of another user's, or of nobody's, is ever sent from here.
    final me = uid();
    final mine = _items.where((q) => q.uid == me).toList();
    if (mine.length != _items.length) {
      _items = mine;
      unawaited(_store());
    }
    if (_items.isNotEmpty) {
      final allStale = _items.every((q) => q.stale(_clock()));
      _status = allStale ? const SosStatus(SosPhase.stale) : const SosStatus(SosPhase.queued);
      if (!allStale) _startTimer();
    }
  }

  static const key = 'sos_queue_v1';

  final SafetyRepository _repo;
  final SharedPreferences _prefs;
  final Duration retryEvery;

  /// How long a try waits for [position] before it goes without one.
  final Duration positionWait;
  final DateTime Function() _clock;

  /// The signed-in user's id, asked afresh each time (null: signed out).
  final String? Function() uid;

  /// The rider's position now, if there is a current one. Asked on the first
  /// try only when the alert has no fresh position of its own, and on every
  /// retry; never waited for longer than [positionWait].
  final Future<SosPosition?> Function()? position;

  late List<QueuedSos> _items;
  SosStatus _status = SosStatus.idle;
  Timer? _timer;
  Future<void>? _running;
  bool _halted = false;

  /// Alerts that have had their first try in this run.
  final _tried = <String>{};
  final _changes = StreamController<SosStatus>.broadcast();

  SosStatus get current => _status;

  /// The status now, then on every change.
  Stream<SosStatus> get status async* {
    yield _status;
    yield* _changes.stream;
  }

  List<QueuedSos> get waiting => List.unmodifiable(_items);

  /// The rider tapped "Alert Deligro". Returns where it stands afterwards.
  Future<SosStatus> alert({double? lat, double? lng, String? orderId}) async {
    final me = uid();
    if (me == null) {
      _set(const SosStatus(SosPhase.refused));
      return _status;
    }
    final item = QueuedSos.create(uid: me, lat: lat, lng: lng, orderId: orderId, now: _clock());
    // One alert waits at a time: the newest tap carries the newest position.
    // It is on the phone and on screen at once, before any position is asked
    // for: a rider with no signal or no GPS fix must not lose it to a wait.
    _items = [item];
    _halted = false;
    _set(const SosStatus(SosPhase.sending));
    await _store();
    _startTimer();
    await flush();
    return _status;
  }

  /// Tries what is waiting. Safe to call at any time (app start, resume).
  Future<void> flush() => _running ??= _drain().whenComplete(() => _running = null);

  Future<void> _drain() async {
    var attempts = _status.attempts;
    while (_items.isNotEmpty) {
      final item = _items.first;
      final me = uid();
      if (item.uid != me) {
        // Not this session's: never sent under it.
        _items.removeWhere((q) => q.id == item.id);
        await _store();
        continue;
      }
      if (item.stale(_clock())) {
        _set(const SosStatus(SosPhase.stale));
        break;
      }
      if (_halted) break;
      attempts++;
      final firstTry = _tried.add(item.id);
      // What is sent is current: the alert's own position while it is fresh,
      // a reading taken now (a first try without one, and every retry), else
      // nothing. The wait is short and the alert is already saved.
      var send = item.freshPosition(_clock());
      if (!firstTry || send == null) {
        final here = await _read();
        // After any wait the alert may have been replaced, or the user
        // changed: nothing goes out for an alert that is no longer here.
        if (!_items.any((q) => q.id == item.id)) continue;
        if (here != null) {
          send = here;
          if (firstTry) {
            _items = [for (final q in _items) q.id == item.id ? q.withPosition(here.lat, here.lng, _clock()) : q];
            await _store();
          }
        }
      }
      // Checked again right before sending, whatever was waited for.
      if (item.uid != uid()) {
        _items.removeWhere((q) => q.id == item.id);
        await _store();
        continue;
      }
      try {
        final ack = await _repo.sos(
          kind: SosKind.alert,
          lat: send?.lat,
          lng: send?.lng,
          orderId: item.orderId,
        );
        _items.removeWhere((q) => q.id == item.id);
        await _store();
        _set(SosStatus(SosPhase.sent, ack: ack));
      } on ApiException catch (e) {
        if (e.status == 400) {
          _items.removeWhere((q) => q.id == item.id);
          await _store();
          _set(const SosStatus(SosPhase.refused));
        } else if (e.status == 401) {
          // The session is not accepted: no use asking again until the same
          // user signs in.
          _halted = true;
          _stopTimer();
          _set(SosStatus(SosPhase.queued, attempts: attempts, needsSignIn: true));
          break;
        } else {
          // Not confirmed: stays queued; the timer tries again.
          _set(SosStatus(SosPhase.queued, attempts: attempts));
          break;
        }
      } catch (e) {
        debugPrint('sos queue: not sent: $e');
        _set(SosStatus(SosPhase.queued, attempts: attempts));
        break;
      }
    }
    if (_items.isEmpty || _halted || _items.every((q) => q.stale(_clock()))) _stopTimer();
  }

  Future<SosPosition?> _read() async {
    final ask = position;
    if (ask == null) return null;
    try {
      return await ask().timeout(positionWait);
    } catch (_) {
      return null; // none in time: the alert goes without one
    }
  }

  /// The signed-in user is [signedIn] now (null after a sign-out). Alerts that
  /// are not theirs are dropped; for the same user, a halt after a 401 ends
  /// and what waits is tried again.
  Future<void> userChanged(String? signedIn) async {
    final mine = _items.where((q) => q.uid == signedIn).toList();
    final dropped = mine.length != _items.length;
    if (dropped) {
      _items = mine;
      await _store();
    }
    if (_items.isEmpty) {
      _halted = false;
      _stopTimer();
      if (dropped || _status.phase == SosPhase.queued || _status.phase == SosPhase.stale) _set(SosStatus.idle);
      return;
    }
    if (_halted) {
      _halted = false;
      _startTimer();
      _set(const SosStatus(SosPhase.queued));
      await flush();
    }
  }

  /// "Send now" on an alert that had gone stale.
  Future<void> sendNow() async {
    if (_items.isEmpty) return;
    _items = [for (final q in _items) q.approve()];
    await _store();
    _startTimer();
    _set(const SosStatus(SosPhase.sending));
    await flush();
  }

  /// "Discard" on an alert that had gone stale.
  Future<void> discard() async {
    _items = [];
    _halted = false;
    await _store();
    _stopTimer();
    _set(SosStatus.idle);
  }

  void _startTimer() {
    _timer ??= Timer.periodic(retryEvery, (_) => unawaited(flush()));
  }

  void _stopTimer() {
    _timer?.cancel();
    _timer = null;
  }

  void _set(SosStatus s) {
    _status = s;
    if (!_changes.isClosed) _changes.add(s);
  }

  /// Forgets a finished result (sent or refused) so the sheet starts clean.
  void reset() {
    if (_status.pending || _status.phase == SosPhase.stale) return;
    _set(SosStatus.idle);
  }

  void dispose() {
    _stopTimer();
    _changes.close();
  }

  Future<void> _store() => _prefs.setString(key, jsonEncode(_items.map((a) => a.toJson()).toList()));

  List<QueuedSos> _load() {
    final raw = _prefs.getString(key);
    if (raw == null) return [];
    try {
      final list = jsonDecode(raw);
      if (list is! List) return [];
      final out = <QueuedSos>[];
      for (final j in list) {
        if (j is! Map) continue;
        try {
          out.add(QueuedSos.fromJson(Map<String, dynamic>.from(j)));
        } catch (_) {
          // An entry with no owner (or unreadable) is not one to send.
        }
      }
      return out;
    } catch (_) {
      return [];
    }
  }
}
