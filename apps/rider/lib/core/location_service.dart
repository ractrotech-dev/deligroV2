import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/env.dart';
import '../models/rider_me.dart';
import '../state/availability.dart';
import '../state/clock.dart';
import '../state/prefs.dart';
import '../state/providers.dart';
import 'api.dart';

/// Whether the phone is ready to share the rider's location.
enum LocationGate {
  ok,

  /// The rider has not yet read and accepted the location disclosure.
  needsDisclosure,

  /// The permission is off, and asking again is allowed (or was just refused).
  denied,

  /// The permission is off for good: only the phone's settings can turn it on.
  deniedForever,

  /// The permission is on, but location is switched off on the phone.
  serviceOff,
}

/// Prefs key for "the rider has seen the location disclosure". The `_v1` is
/// the wording: a change that needs fresh consent bumps it.
const locationDisclosureKey = 'loc_disclosure_v1';

/// Idle riders post a fix every 30 s; on a delivery, every 10 s.
const _idleEvery = Duration(seconds: 30);
const _activeEvery = Duration(seconds: 10);

/// While the server cannot record presence (migration 0081 not applied),
/// every try fails the same way, so ask only now and then.
const _migrationBackoff = Duration(minutes: 2);

const _notificationTitle = 'Deligro Rider is online';
const _notificationText =
    "Sharing your location with Deligro ops while you're online.";

typedef PostLocation =
    Future<({bool online, bool active})> Function(double lat, double lng);

/// A reading from the phone and when it came.
typedef RiderFix = ({double lat, double lng, DateTime at});

/// After the website said "not online" (and not on a delivery), a silent
/// resume, from /me or from the board, waits at least this long since the
/// last one: a server that disagrees with itself must not loop the service.
const silentResumeBackoff = Duration(minutes: 1);

/// The rider's phone telling Deligro where it is, while they are online.
///
/// A geolocator position stream runs as an Android foreground service (the
/// ongoing notification), which is what keeps fixes coming with the screen
/// locked. Readings are throttled before they reach the website: one per 30 s,
/// one per 10 s on a delivery, the first one at once, and a one-off reading
/// when the stream has gone quiet.
class LocationService {
  LocationService({
    required this.prefs,
    required this.post,
    required this.onServerOffline,
    this.onGate,
    this.onFix,
    this.onPosted,
    DateTime Function()? now,
    Future<void> Function()? ensureNotificationPermission,
    GeolocatorPlatform? geolocator,
    this.heartbeatEvery = const Duration(seconds: 5),
  }) : now = now ?? DateTime.now,
       _ensureNotifications =
           ensureNotificationPermission ?? _askForNotifications,
       _geoOverride = geolocator;

  final SharedPreferences prefs;
  final PostLocation post;

  /// Called after the website answers that the rider is neither online nor on
  /// a delivery: the service has stopped, and the app should re-read the
  /// rider's status.
  final void Function() onServerOffline;

  /// Tells the app why sharing is not happening (null: it is, or nothing is
  /// wanted). An online rider with no position must never be a silent state.
  final void Function(LocationGate? problem)? onGate;

  /// Every reading the phone gives while sharing, before any throttling: the
  /// delivery screen's map and "you're near" use it.
  final void Function(RiderFix fix)? onFix;

  /// A post went through: the website can be reached right now. The app sends
  /// the delivery steps saved with no signal then, whatever tab is showing.
  final void Function()? onPosted;
  final DateTime Function() now;

  /// How often to look for a quiet stream; null turns the heartbeat off.
  final Duration? heartbeatEvery;
  final Future<void> Function() _ensureNotifications;
  final GeolocatorPlatform? _geoOverride;

  GeolocatorPlatform get _geo => _geoOverride ?? GeolocatorPlatform.instance;

  StreamSubscription<Position>? _sub;
  Timer? _timer;
  bool _running = false;
  bool _active = false;

  /// Bumped on every start, stop and suspend. Anything that outlives the run
  /// that began it (a slow post, a slow reading, a timer tick) compares its
  /// own number and walks away if it is stale.
  int _generation = 0;

  /// The generation with a post, or a heartbeat reading, in flight (-1: none).
  int _postingGen = -1;
  int _heartbeatGen = -1;
  DateTime _startedAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime? _lastPostAt;
  DateTime? _backoffUntil;
  LocationGate? _published;

  /// Started (or starting) and not stopped since.
  bool get running => _running;

  Duration get _cadence => _active ? _activeEvery : _idleEvery;

  void _publish(LocationGate? gate) {
    if (_published == gate) return;
    _published = gate;
    onGate?.call(gate);
  }

  /// Lets the card say why a try to go online stopped short (or clear it).
  void report(LocationGate? gate) => _publish(gate);

  /// Remembers that the rider has read the disclosure and said Continue.
  Future<void> acceptDisclosure() => prefs.setBool(locationDisclosureKey, true);

  /// Whether sharing can start now. Asks for the permission when it can; pass
  /// `prompt: false` to only look (used when the app reopens while the rider
  /// is already online, where a prompt out of nowhere would be rude).
  Future<LocationGate> check({bool prompt = true}) async {
    if (prefs.getBool(locationDisclosureKey) != true) {
      return LocationGate.needsDisclosure;
    }
    var permission = await _geo.checkPermission();
    if (permission == LocationPermission.denied && prompt) {
      permission = await _geo.requestPermission();
    }
    switch (permission) {
      case LocationPermission.deniedForever:
        return LocationGate.deniedForever;
      case LocationPermission.denied:
      case LocationPermission.unableToDetermine:
        return LocationGate.denied;
      case LocationPermission.whileInUse:
      case LocationPermission.always:
        break;
    }
    if (!await _geo.isLocationServiceEnabled()) return LocationGate.serviceOff;
    return LocationGate.ok;
  }

  Future<bool> openAppSettings() => _geo.openAppSettings();

  Future<bool> openLocationSettings() => _geo.openLocationSettings();

  /// Opens the position stream (and with it the foreground notification).
  /// A second call while running does nothing. [askNotifications] is false on
  /// the silent resume path, which must not put a prompt in front of the rider.
  Future<void> start({
    required bool activeDelivery,
    bool askNotifications = true,
  }) async {
    if (_running) return;
    _running = true;
    _active = activeDelivery;
    _lastPostAt = null;
    _backoffUntil = null;
    _startedAt = now();
    final generation = ++_generation;

    if (askNotifications) {
      try {
        await _ensureNotifications();
      } catch (e) {
        debugPrint('location: notification permission: $e');
      }
    }
    // Stopped (or stopped and started again) while the prompt was up.
    if (!_running || generation != _generation) return;

    _openStream(generation);
    final every = heartbeatEvery;
    if (every != null) {
      _timer = Timer.periodic(
        every,
        (_) => unawaited(_heartbeat(generation)),
      );
    }
    _publish(null);
  }

  void _openStream(int generation) {
    _sub = _geo
        .getPositionStream(locationSettings: _settings())
        .listen(
          (p) => unawaited(_onFix(p, generation)),
          onError: (Object e) {
            debugPrint('location stream: $e');
            unawaited(_onStreamProblem(e, generation));
          },
        );
  }

  /// Starts again after the app reopens on a rider who is still online, or
  /// after they fixed what stopped it. Silent by default: no permission prompt
  /// and no notification prompt. A phone that is not ready is reported through
  /// [onGate] instead, so the rider is told.
  Future<void> resume({
    required bool activeDelivery,
    bool prompt = false,
  }) async {
    if (_running) return;
    final gate = await check(prompt: prompt);
    if (gate != LocationGate.ok) {
      if (!_running) _publish(gate);
      return;
    }
    await start(activeDelivery: activeDelivery, askNotifications: prompt);
  }

  /// Phase 2 calls this as a delivery is picked up and finished. The stream is
  /// reopened with the matching interval (10 s on a delivery, 30 s idle).
  Future<void> setActiveDelivery(bool active) async {
    if (_active == active) return;
    _active = active;
    final old = _sub;
    if (!_running || old == null) return;
    final generation = _generation;
    _sub = null;
    await old.cancel();
    if (!_running || generation != _generation) return;
    _openStream(generation);
  }

  /// [publish] is false when the whole app is going away.
  Future<void> stop({bool publish = true}) async {
    final sub = _end();
    if (publish) _publish(null);
    await sub?.cancel();
  }

  /// Ends the run: nothing from it may act afterwards.
  StreamSubscription<Position>? _end() {
    _generation++;
    _running = false;
    _timer?.cancel();
    _timer = null;
    final sub = _sub;
    _sub = null;
    return sub;
  }

  /// The phone stopped giving positions (permission gone, location switched
  /// off) while the rider is online: say so, and stop until it is fixed.
  Future<void> _suspend(LocationGate gate) async {
    final sub = _end();
    _publish(gate);
    await sub?.cancel();
  }

  /// A permission or switched-off-location error from the phone. If a fresh
  /// look says it really is not ok, the rider is told; otherwise it was a blip.
  Future<void> _onStreamProblem(Object e, int generation) async {
    if (e is! PermissionDeniedException &&
        e is! LocationServiceDisabledException) {
      return;
    }
    if (!_running || generation != _generation) return;
    final gate = await check(prompt: false);
    if (!_running || generation != _generation || gate == LocationGate.ok) {
      return;
    }
    await _suspend(gate);
  }

  /// If the stream has been quiet for a whole interval, asks the phone for a
  /// reading instead. Runs on a timer; public for tests.
  @visibleForTesting
  Future<void> heartbeat() => _heartbeat(_generation);

  Future<void> _heartbeat(int generation) async {
    if (!_running || generation != _generation) return;
    if (_postingGen == generation || _heartbeatGen == generation) return;
    final since = _lastPostAt ?? _startedAt;
    if (now().difference(since) < _cadence || _backingOff) return;
    _heartbeatGen = generation;
    try {
      final p = await _geo.getCurrentPosition(
        locationSettings: LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: const Duration(seconds: 15),
        ),
      );
      await _onFix(p, generation);
    } catch (e) {
      debugPrint('location heartbeat: $e');
      await _onStreamProblem(e, generation);
    } finally {
      if (_heartbeatGen == generation) _heartbeatGen = -1;
    }
  }

  bool get _backingOff {
    final until = _backoffUntil;
    return until != null && now().isBefore(until);
  }

  Future<void> _onFix(Position p, int generation) async {
    if (!_running || generation != _generation) return;
    onFix?.call((lat: p.latitude, lng: p.longitude, at: now()));
    if (_postingGen == generation || _backingOff) return;
    final last = _lastPostAt;
    if (last != null && now().difference(last) < _cadence) return;

    _postingGen = generation;
    _lastPostAt = now();
    try {
      final answer = await post(p.latitude, p.longitude);
      if (generation != _generation) return;
      _backoffUntil = null;
      onPosted?.call();
      // Only a 2xx can say "not online": on a partial failure the website
      // reports online:false because the presence write is what failed.
      // A delivery in flight (`active`) keeps the service going whatever
      // `online` says (presence can lapse mid-delivery, and the customer is
      // watching the dot): stop only when the server says neither.
      if (answer.active) {
        // Pick up the delivery cadence if the run began without knowing.
        if (!_active) unawaited(setActiveDelivery(true));
      } else if (!answer.online) {
        await _serverSaysOffline();
      }
    } on ApiException catch (e) {
      if (generation != _generation) return;
      if (e.status == 503 || e.code == 'migration_pending') {
        _backoffUntil = now().add(_migrationBackoff);
      } else {
        debugPrint('location post: $e');
      }
    } catch (e) {
      debugPrint('location post: $e');
    } finally {
      if (_postingGen == generation) _postingGen = -1;
    }
  }

  Future<void> _serverSaysOffline() async {
    await stop();
    onServerOffline();
  }

  LocationSettings _settings() {
    if (defaultTargetPlatform == TargetPlatform.android) {
      return AndroidSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 0,
        // The phone's own pace: 30 s idle, 10 s on a delivery. Readings that
        // come faster are still throttled before they are posted.
        intervalDuration: _cadence,
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: _notificationTitle,
          notificationText: _notificationText,
          // White on transparent, as a status-bar icon must be (res/drawable;
          // also used by RingService, so resource shrinking keeps it).
          notificationIcon: AndroidResource(name: 'ic_stat_ring'),
          enableWakeLock: true,
          setOngoing: true,
        ),
      );
    }
    return LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: 0);
  }
}

/// Android 13+ shows the foreground notification only with the notification
/// permission. OneSignal already owns that prompt; this asks it again, which
/// returns at once when the answer is already given.
Future<void> _askForNotifications() async {
  if (Env.oneSignalAppId.isEmpty) return;
  await OneSignal.Notifications.requestPermission(
    true,
  ).timeout(const Duration(seconds: 30), onTimeout: () => false);
}

/// How often the service checks for a quiet stream. Tests turn it off, because
/// a periodic timer left running fails a widget test.
final locationHeartbeatProvider = Provider<Duration?>(
  (_) => const Duration(seconds: 5),
);

/// Why the rider is not sharing a location, or null. The availability card
/// shows it, for an online rider as much as for one trying to go online.
class LocationGateNotifier extends Notifier<LocationGate?> {
  @override
  LocationGate? build() => null;

  void set(LocationGate? gate) => state = gate;
}

final locationGateProvider =
    NotifierProvider<LocationGateNotifier, LocationGate?>(
      LocationGateNotifier.new,
    );

/// The rider's latest position while the service shares it; null before the
/// first reading.
class LatestFixNotifier extends Notifier<RiderFix?> {
  @override
  RiderFix? build() => null;

  void set(RiderFix? fix) => state = fix;
}

final latestFixProvider = NotifierProvider<LatestFixNotifier, RiderFix?>(
  LatestFixNotifier.new,
);

/// The one location service, tied to the session: it stops when the rider
/// signs out, when a different rider signs in, when the gate sends the app to
/// /login, /not-rider or /needs-update, and when the website says the rider is
/// offline. It starts again by itself for a rider who is online (when the app
/// opens, and when /me answers again after an outage).
///
/// Keep it watched (the app does, in RiderApp): Riverpod pauses the listeners
/// of a provider nobody is listening to.
final locationServiceProvider = Provider<LocationService>((ref) {
  // Set once the website has said "not online" from a post: from then on a
  // silent resume waits [silentResumeBackoff] since the last one.
  var serverSaidOffline = false;
  DateTime? lastSilentResume;

  // What the board said last: a live delivery, none, or nothing yet (null,
  // until the board has answered once). The board writes the cache on every
  // answer; ruling R17: the board's active delivery drives the cadence.
  bool? boardSaysCarrying;

  final service = LocationService(
    heartbeatEvery: ref.watch(locationHeartbeatProvider),
    prefs: ref.watch(prefsProvider),
    post: (lat, lng) => ref.read(riderRepoProvider).postLocation(lat, lng),
    onServerOffline: () {
      serverSaidOffline = true;
      // The server's word is newer than the board's last answer: /me (asked
      // again now) decides whether a delivery still keeps sharing on.
      boardSaysCarrying = null;
      ref.invalidate(meProvider);
    },
    onGate: (gate) => ref.read(locationGateProvider.notifier).set(gate),
    onFix: (fix) => ref.read(latestFixProvider.notifier).set(fix),
    // The signal is back: what was saved offline goes now (I-4), not only
    // when the Jobs tab next asks the board.
    onPosted: () {
      try {
        final queue = ref.read(actionQueueProvider);
        if (queue.current.isNotEmpty) unawaited(queue.flush());
      } catch (_) {}
    },
  );
  ref.onDispose(() => unawaited(service.stop(publish: false)));

  /// Carrying an order: the board's word once it has spoken, /me's before.
  bool onDelivery() =>
      boardSaysCarrying ?? readCurrentMe(ref)?.activeDeliveryId != null;

  bool online() => ref.read(availabilityProvider).isOnline;

  /// The app restarting sharing on its own (no prompt). Rate-limited once the
  /// server has said "offline", so /me and the board cannot loop it.
  void resume() {
    if (service.running) return;
    if (serverSaidOffline) {
      final now = ref.read(clockProvider)();
      final last = lastSilentResume;
      if (last != null && now.difference(last) < silentResumeBackoff) return;
      lastSilentResume = now;
    }
    unawaited(service.resume(activeDelivery: onDelivery()));
  }

  /// Neither online nor carrying an order: stop. Also clears a suspended
  /// gate (a permission notice) the rider no longer needs to act on.
  void stopIfFree() {
    if (!online() && !onDelivery()) unawaited(service.stop());
  }

  final cacheChanges = ref.read(activeCacheProvider).changes.listen((active) {
    final carrying = active != null && active.status.live;
    final was = boardSaysCarrying;
    boardSaysCarrying = carrying;
    // 10 s while a delivery is on, whatever the server says about `online`;
    // back to 30 s once the board has no delivery.
    unawaited(service.setActiveDelivery(carrying));
    if (carrying) {
      resume();
    } else if (was != false) {
      // The delivery just ended (or the board's first word is "none"). Only
      // on that change: the board answers every 5 s, and a notice the rider
      // still has to act on must not be wiped by each answer.
      stopIfFree();
    }
  });
  ref.onDispose(cacheChanges.cancel);

  ref.listen(userIdProvider, (prev, next) {
    if (prev != next) {
      boardSaysCarrying = null;
      serverSaidOffline = false;
      lastSilentResume = null;
      unawaited(service.stop());
    }
  });
  ref.listen(meProvider, (_, next) {
    final e = next.error;
    // 401 -> /login, 403 -> /not-rider, 404 or `not_configured` ->
    // /needs-update: the server cannot take positions there. A lost
    // connection or any 5xx (even an edge's non-JSON 503) is a blip: the
    // server still has the rider online, so sharing goes on.
    if (e is ApiException &&
        (e.status == 401 || e.status == 403 || e.serverUnsupported)) {
      unawaited(service.stop());
    } else if (next.hasValue && !next.hasError && !next.isLoading) {
      // This answer is the newest word on the rider's status (the
      // availability provider built from it may not have caught up yet).
      final nowOnline = readCurrentMe(ref)?.availability.isOnline ?? online();
      if (nowOnline || onDelivery()) {
        resume(); // /me is answering again: an online rider keeps sharing
      } else if (service.running) {
        unawaited(service.stop()); // offline, and the delivery is over
      }
    }
  });
  ref.listen<RiderAvailabilityDto>(availabilityProvider, (_, a) {
    // Not online is not "stop" while a delivery is in flight: presence can
    // lapse mid-delivery and the customer is still following the dot.
    if (!a.isOnline && !onDelivery()) {
      stopIfFree();
      return;
    }
    resume();
  }, fireImmediately: true);
  return service;
});
