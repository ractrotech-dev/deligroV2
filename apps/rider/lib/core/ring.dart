import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/jobs.dart';
import '../state/clock.dart';
import '../state/prefs.dart';

// The ring: a new offer rings the rider's phone, loudly and until they answer,
// because a rider with the phone in a jacket misses one beep. The server sends
// `{ring: 'start' | 'stop', ringId, timeoutSec, sentAt}` as push data
// (src/lib/alerts/ring.ts); RingNotificationExtension.kt reads it even with
// the app closed and RingService.kt does the ringing. Everything in this file
// is the app's side of that: the same payload and rules in Dart (tested, and
// checked against the Kotlin sources by test/ring_test.dart), the channel to
// the service, and the open board ringing for an offer whose push never came.

/// The notification channel of the ringing service, and of the "order still
/// waiting" notice it leaves when nobody answered.
const ringChannelId = 'deligro_ring';
const ringMissedChannelId = 'deligro_missed';

/// Where the phone keeps its memory of stops (SharedPreferences file name).
const ringStoppedPrefs = 'deligro_ring_stopped';

/// The keys of the ring payload, `RING_KEYS` in src/lib/alerts/ring.ts.
const ringPayloadKeys = ['ring', 'ringId', 'timeoutSec', 'sentAt'];

/// The optional key of a rider ring (`RING_HELD_KEY` in ring.ts): false for a
/// heads-up ring, which follows the sound and vibration switches. Absent or
/// true means the order is held for this rider.
const ringHeldKey = 'held';

/// The ring id of the Settings "Test the alert" button, and how long it rings.
/// RingService leaves no "order still waiting" notice for it.
const testRingId = 'test:alert';
const testRingSeconds = 3;

/// How long the phone remembers a stop: longer than any ring lasts.
const ringStopMemory = Duration(minutes: 15);

/// A ring never lasts less than a second or more than ten minutes.
const _minTimeoutSec = 1;
const _maxTimeoutSec = 600;
const _defaultTimeoutSec = 180;

/// The same id the server's pushes use, so a ring the board started stops when
/// the server's stop arrives, and the other way round.
String riderRingId(String orderId) => 'rider:$orderId';

sealed class RingMessage {
  const RingMessage(this.ringId, this.sentAt);

  final String ringId;

  /// The server's clock (ms). Two server times are compared with each other,
  /// never with the phone's, so a wrong phone clock cannot silence an order.
  final int sentAt;
}

class RingStart extends RingMessage {
  const RingStart(super.ringId, this.timeoutSec, super.sentAt, {this.held = true});

  /// The push's own timeout, 1..600 s. The rider's window is whatever the
  /// server says it is, not a number baked into the app.
  final int timeoutSec;

  /// Whether the order is held for this rider; false for a heads-up ring.
  final bool held;
}

class RingStop extends RingMessage {
  const RingStop(super.ringId, super.sentAt);
}

int? _asInt(Object? v) => switch (v) {
      num n => n.round(),
      String s => int.tryParse(s) ?? double.tryParse(s)?.round(),
      _ => null,
    };

bool? _asBool(Object? v) => switch (v) {
      bool b => b,
      String s when s == 'true' => true,
      String s when s == 'false' => false,
      _ => null,
    };

/// Reads a push's data. Null for anything that is not a ring (a normal push).
RingMessage? parseRingMessage(Map<String, dynamic>? data) {
  if (data == null) return null;
  final ringId = data['ringId'];
  if (ringId is! String || ringId.isEmpty) return null;
  // Only the rider's own rings: every Deligro app shares one OneSignal app, so
  // a kitchen's `vendor:` or an ops ring can reach this phone (native filter:
  // RingNotificationExtension.kt).
  if (!ringId.startsWith('rider:') && !ringId.startsWith('test:')) return null;
  final sentAt = _asInt(data['sentAt']) ?? 0;
  return switch (data['ring']) {
    'start' => RingStart(
        ringId,
        (_asInt(data['timeoutSec']) ?? _defaultTimeoutSec).clamp(_minTimeoutSec, _maxTimeoutSec),
        sentAt,
        held: _asBool(data[ringHeldKey]) ?? true,
      ),
    'stop' => RingStop(ringId, sentAt),
    _ => null,
  };
}

/// The phone's memory of stops. FCM does not keep messages in order, so a stop
/// can arrive before its start; a start the server sent at or before a stop we
/// already have is not rung. A later start (a re-offer) is newer than the stop
/// and rings normally. A stop made on this phone (`sentAt` 0) and a start with
/// no server time (the open board's) are never remembered or refused.
class RingLedger {
  RingLedger({DateTime Function()? now}) : _now = now ?? DateTime.now;

  final DateTime Function() _now;
  final _stops = <String, ({int sentAt, DateTime expires})>{};

  int get length => _stops.length;

  void rememberStop(RingStop stop) {
    if (stop.sentAt <= 0) return;
    final now = _now();
    _stops.removeWhere((_, v) => v.expires.isBefore(now));
    final known = _stops[stop.ringId];
    final sentAt = known != null && known.sentAt > stop.sentAt ? known.sentAt : stop.sentAt;
    _stops[stop.ringId] = (sentAt: sentAt, expires: now.add(ringStopMemory));
  }

  bool shouldRing(RingStart start) {
    if (start.sentAt <= 0) return true;
    final known = _stops[start.ringId];
    if (known == null || known.expires.isBefore(_now())) return true;
    return known.sentAt < start.sentAt;
  }
}

/// What a ring may play. The sound and vibration switches in Settings quiet a
/// ring, except while the offer is held for this rider: that window is short
/// and missing it costs the order.
class RingOutput {
  const RingOutput({required this.sound, required this.vibrate});

  final bool sound;
  final bool vibrate;

  bool get silent => !sound && !vibrate;

  factory RingOutput.resolve({required bool held, required bool soundOn, required bool vibrateOn}) =>
      RingOutput(sound: held || soundOn, vibrate: held || vibrateOn);
}

/// What stands between this phone and a ring that actually wakes it.
class RingSetup {
  const RingSetup({
    required this.notifications,
    required this.fullScreen,
    required this.batteryUnrestricted,
    required this.manufacturer,
  });

  factory RingSetup.fromMap(Map<Object?, Object?> m) => RingSetup(
        notifications: m['notifications'] == true,
        fullScreen: m['fullScreen'] != false,
        batteryUnrestricted: m['batteryUnrestricted'] == true,
        manufacturer: '${m['manufacturer'] ?? ''}',
      );

  final bool notifications;
  final bool fullScreen;
  final bool batteryUnrestricted;
  final String manufacturer;

  /// Makers whose own "autostart" switch can stop a ring from waking the app.
  bool get hasAutostart => const {
        'xiaomi',
        'redmi',
        'poco',
        'vivo',
        'iqoo',
        'oppo',
        'realme',
        'oneplus',
      }.contains(manufacturer.toLowerCase());

  bool get ready => notifications && fullScreen && batteryUnrestricted;
}

/// The native ring (RingService.kt) through MainActivity's `deligro/ring`
/// channel. Every call is best-effort: a phone that cannot ring still works.
class RingChannel {
  static const _ch = MethodChannel('deligro/ring');

  /// Rings for [ringId] until it is stopped or [timeoutSec] runs out. [held] is
  /// true for an offer held for this rider, which ignores the sound and
  /// vibration switches. False when the phone refused or there is no service.
  Future<bool> start(
    String ringId, {
    required String title,
    required String body,
    int timeoutSec = _defaultTimeoutSec,
    bool held = true,
  }) async {
    try {
      return await _ch.invokeMethod<bool>('start', {
            'ringId': ringId,
            'title': title,
            'body': body,
            'timeoutSec': timeoutSec,
            'held': held,
          }) ??
          false;
    } catch (_) {
      return false;
    }
  }

  /// Rings the test alert: [testRingSeconds] seconds, following the rider's
  /// sound and vibration switches (never held). False when both are off, which
  /// would make no sound at all, or when the phone refused.
  Future<bool> testAlert(RiderPrefs prefs) async {
    final out = RingOutput.resolve(held: false, soundOn: prefs.ringSound, vibrateOn: prefs.ringVibrate);
    if (out.silent) return false;
    return start(
      testRingId,
      title: 'Test alert',
      body: 'This is how a new order will ring.',
      timeoutSec: testRingSeconds,
      held: false,
    );
  }

  /// `*` stops every ring.
  Future<void> stop(String ringId) async {
    try {
      await _ch.invokeMethod<bool>('stop', {'ringId': ringId});
    } catch (_) {}
  }

  Future<RingSetup?> setup() async {
    try {
      final m = await _ch.invokeMethod<Map<Object?, Object?>>('setup');
      return m == null ? null : RingSetup.fromMap(m);
    } catch (_) {
      return null;
    }
  }

  /// [which]: `notifications`, `channel` (the settings of the `deligro_ring`
  /// channel), `fullScreen`, `battery` or `autostart`.
  Future<void> openSettings(String which) async {
    try {
      await _ch.invokeMethod<bool>('openSettings', {'which': which});
    } catch (_) {}
  }

  /// The app route a tap on the ring notification asked for (once), or null.
  Future<String?> takeLaunchRoute() async {
    try {
      return await _ch.invokeMethod<String>('takeLaunchRoute');
    } catch (_) {
      return null;
    }
  }
}

final ringChannelProvider = Provider<RingChannel>((_) => RingChannel());

/// Rings, from the open board, for every offer held for this rider whose
/// window is still running: the push extension covers the app being closed,
/// this covers a push that never arrived. Stops when the offer leaves the
/// board, and never starts again for one the rider has just answered.
class BoardRinger extends Notifier<Set<String>> {
  final _answered = <String>{};

  @override
  Set<String> build() => const {};

  Future<void> sync(RiderBoard board) async {
    // The offer's window is counted on the server's clock.
    final now = ref.read(serverClockProvider)();
    final listed = {for (final o in board.offers) o.orderId};
    _answered.retainAll(listed);

    final wanted = <String, RiderOffer>{
      for (final o in board.offers)
        if (_holding(o, now) && !_answered.contains(o.orderId)) riderRingId(o.orderId): o,
    };
    final stop = state.difference(wanted.keys.toSet());
    final start = wanted.keys.toSet().difference(state);
    if (stop.isEmpty && start.isEmpty) return;

    final ch = ref.read(ringChannelProvider);
    for (final id in stop) {
      await ch.stop(id);
    }
    final started = <String>{};
    for (final id in start) {
      // A held offer always rings: the Settings switches never quiet it
      // (RingOutput.resolve), so there is nothing to check here.
      final o = wanted[id]!;
      final left = o.offerExpiresAt!.difference(now).inSeconds;
      final line = o.drop.line;
      final ok = await ch.start(
        id,
        title: 'Order held for you',
        body: line == null || line.isEmpty ? o.shop.name : '${o.shop.name} · $line',
        timeoutSec: left.clamp(_minTimeoutSec, _maxTimeoutSec),
      );
      // A phone that would not ring is asked again by the next board.
      if (ok) started.add(id);
    }
    state = {...state.difference(stop), ...started};
  }

  /// The rider accepted or rejected [orderId]: its ring ends now, and the
  /// board that still lists it for a moment does not start it again.
  Future<void> answered(String orderId) async {
    _answered.add(orderId);
    final id = riderRingId(orderId);
    await ref.read(ringChannelProvider).stop(id);
    state = state.difference({id});
  }

  Future<void> stopAll() async {
    await ref.read(ringChannelProvider).stop('*');
    _answered.clear();
    state = const {};
  }

  static bool _holding(RiderOffer o, DateTime now) {
    final until = o.offerExpiresAt;
    return o.reservedForYou && until != null && until.isAfter(now);
  }
}

final boardRingerProvider = NotifierProvider<BoardRinger, Set<String>>(BoardRinger.new);
