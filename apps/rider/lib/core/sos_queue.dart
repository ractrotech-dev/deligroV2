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

/// An "Alert Deligro" the server has not confirmed yet.
class QueuedSos {
  const QueuedSos({required this.id, this.lat, this.lng, this.orderId, required this.queuedAt});

  factory QueuedSos.create({double? lat, double? lng, String? orderId, DateTime? now}) =>
      QueuedSos(id: const Uuid().v4(), lat: lat, lng: lng, orderId: orderId, queuedAt: now ?? DateTime.now());

  final String id;
  final double? lat;
  final double? lng;
  final String? orderId;
  final DateTime queuedAt;

  QueuedSos at(double lat, double lng) =>
      QueuedSos(id: id, lat: lat, lng: lng, orderId: orderId, queuedAt: queuedAt);

  Map<String, dynamic> toJson() => {
        'id': id,
        'lat': lat,
        'lng': lng,
        'orderId': orderId,
        'queuedAt': queuedAt.toUtc().toIso8601String(),
      };

  factory QueuedSos.fromJson(Map<String, dynamic> j) => QueuedSos(
        id: j['id'] as String,
        lat: (j['lat'] as num?)?.toDouble(),
        lng: (j['lng'] as num?)?.toDouble(),
        orderId: j['orderId'] as String?,
        queuedAt: DateTime.tryParse('${j['queuedAt']}') ?? DateTime.now(),
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
}

class SosStatus {
  const SosStatus(this.phase, {this.ack, this.attempts = 0});

  final SosPhase phase;
  final SosAck? ack;

  /// Tries made for the alert now waiting.
  final int attempts;

  static const idle = SosStatus(SosPhase.idle);

  bool get pending => phase == SosPhase.sending || phase == SosPhase.queued;
}

/// "Alert Deligro" that survives having no signal.
///
/// The tap is written to the phone first (prefs `sos_queue_v1`, so it
/// survives the app being killed) and sent from there. Nothing here says
/// anything was sent until the server has answered 2xx:
///
///  * no connection, a 5xx, a session that needs refreshing, 429: keep it, try
///    again every [retryEvery] (15 s) with the rider's newest position;
///  * a refusal (400): drop it and report [SosPhase.refused];
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
    this.retryEvery = sosRetryEvery,
    this.position,
  }) {
    _items = _load();
    if (_items.isNotEmpty) {
      _status = const SosStatus(SosPhase.queued);
      _startTimer();
    }
  }

  static const key = 'sos_queue_v1';

  final SafetyRepository _repo;
  final SharedPreferences _prefs;
  final Duration retryEvery;
  /// The rider's newest position, asked afresh on every try.
  final ({double lat, double lng})? Function()? position;

  late List<QueuedSos> _items;
  SosStatus _status = SosStatus.idle;
  Timer? _timer;
  Future<void>? _running;
  final _changes = StreamController<SosStatus>.broadcast();

  SosStatus get current => _status;

  /// The status now, then on every change.
  Stream<SosStatus> get status async* {
    yield _status;
    yield* _changes.stream;
  }

  List<QueuedSos> get waiting => List.unmodifiable(_items);

  /// The rider tapped "Alert Deligro". Returns where it stands afterwards.
  Future<SosStatus> alert({double? lat, double? lng, String? orderId, DateTime? now}) async {
    final here = position?.call();
    final item = QueuedSos.create(
      lat: lat ?? here?.lat,
      lng: lng ?? here?.lng,
      orderId: orderId,
      now: now,
    );
    // One alert waits at a time: the newest tap carries the newest position.
    _items = [item];
    await _store();
    _startTimer();
    _set(const SosStatus(SosPhase.sending));
    await flush();
    return _status;
  }

  /// Tries what is waiting. Safe to call at any time (app start, resume).
  Future<void> flush() => _running ??= _drain().whenComplete(() => _running = null);

  Future<void> _drain() async {
    var attempts = _status.attempts;
    while (_items.isNotEmpty) {
      final item = _items.first;
      final here = position?.call();
      final send = here == null ? item : item.at(here.lat, here.lng);
      attempts++;
      try {
        final ack = await _repo.sos(
          kind: SosKind.alert,
          lat: send.lat,
          lng: send.lng,
          orderId: send.orderId,
        );
        _items.removeWhere((q) => q.id == item.id);
        await _store();
        _set(SosStatus(SosPhase.sent, ack: ack));
      } on ApiException catch (e) {
        if (e.status == 400) {
          _items.removeWhere((q) => q.id == item.id);
          await _store();
          _set(const SosStatus(SosPhase.refused));
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
    if (_items.isEmpty) _stopTimer();
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
    if (_status.pending) return;
    _set(SosStatus.idle);
  }

  void dispose() {
    _stopTimer();
    _changes.close();
  }

  Future<void> _store() =>
      _prefs.setString(key, jsonEncode(_items.map((a) => a.toJson()).toList()));

  List<QueuedSos> _load() {
    final raw = _prefs.getString(key);
    if (raw == null) return [];
    try {
      final list = jsonDecode(raw);
      if (list is! List) return [];
      return [
        for (final j in list)
          if (j is Map) QueuedSos.fromJson(Map<String, dynamic>.from(j)),
      ];
    } catch (_) {
      return [];
    }
  }
}
