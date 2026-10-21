import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:onesignal_flutter/onesignal_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/env.dart';
import '../models/rider_me.dart';
import '../state/availability.dart';
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
    "Sharing your location with Deligro dispatch while you're online.";

typedef PostLocation =
    Future<({bool online, bool active})> Function(double lat, double lng);

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

  /// Called after the website answers that the rider is not online: the
  /// service has stopped, and the app should re-read the rider's status.
  final void Function() onServerOffline;
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
  bool _posting = false;
  int _generation = 0;
  DateTime _startedAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime? _lastPostAt;
  DateTime? _backoffUntil;

  /// Started (or starting) and not stopped since.
  bool get running => _running;

  Duration get _cadence => _active ? _activeEvery : _idleEvery;

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
  /// A second call while running does nothing.
  Future<void> start({required bool activeDelivery}) async {
    if (_running) return;
    _running = true;
    _active = activeDelivery;
    _lastPostAt = null;
    _backoffUntil = null;
    _startedAt = now();
    final generation = ++_generation;

    try {
      await _ensureNotifications();
    } catch (e) {
      debugPrint('location: notification permission: $e');
    }
    // Stopped (or stopped and started again) while the prompt was up.
    if (!_running || generation != _generation) return;

    _sub = _geo
        .getPositionStream(locationSettings: _settings())
        .listen(
          (p) => unawaited(_onFix(p)),
          onError: (Object e) => debugPrint('location stream: $e'),
        );
    final every = heartbeatEvery;
    if (every != null) {
      _timer = Timer.periodic(every, (_) => unawaited(heartbeat()));
    }
  }

  /// Starts again after the app reopens on a rider who is still online, if
  /// that needs no questions asked.
  Future<void> resume({required bool activeDelivery}) async {
    if (_running) return;
    if (await check(prompt: false) != LocationGate.ok) return;
    await start(activeDelivery: activeDelivery);
  }

  /// Phase 2 calls this as a delivery is picked up and finished.
  Future<void> setActiveDelivery(bool active) async {
    _active = active;
  }

  Future<void> stop() async {
    _generation++;
    _running = false;
    _timer?.cancel();
    _timer = null;
    final sub = _sub;
    _sub = null;
    await sub?.cancel();
  }

  /// If the stream has been quiet for a whole interval, asks the phone for a
  /// reading instead. Runs on a timer; public for tests.
  @visibleForTesting
  Future<void> heartbeat() async {
    if (!_running || _posting) return;
    final since = _lastPostAt ?? _startedAt;
    if (now().difference(since) < _cadence || _backingOff) return;
    try {
      final p = await _geo.getCurrentPosition(
        locationSettings: LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: const Duration(seconds: 15),
        ),
      );
      await _onFix(p);
    } catch (e) {
      debugPrint('location heartbeat: $e');
    }
  }

  bool get _backingOff {
    final until = _backoffUntil;
    return until != null && now().isBefore(until);
  }

  Future<void> _onFix(Position p) async {
    if (!_running || _posting || _backingOff) return;
    final last = _lastPostAt;
    if (last != null && now().difference(last) < _cadence) return;

    _posting = true;
    _lastPostAt = now();
    final generation = _generation;
    try {
      final answer = await post(p.latitude, p.longitude);
      if (generation != _generation) return;
      _backoffUntil = null;
      // Only a 2xx can say "not online": on a partial failure the website
      // reports online:false because the presence write is what failed.
      if (!answer.online) await _serverSaysOffline();
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
      _posting = false;
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
        intervalDuration: _activeEvery,
        foregroundNotificationConfig: const ForegroundNotificationConfig(
          notificationTitle: _notificationTitle,
          notificationText: _notificationText,
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

/// The one location service, tied to the session: it stops when the rider
/// signs out, when a different rider signs in, when the gate says this account
/// is not a rider, and when the website says the rider is offline. It starts
/// again by itself when the app opens on a rider who is still online.
///
/// Keep it watched (the app does, in RiderApp): Riverpod pauses the listeners
/// of a provider nobody is listening to.
final locationServiceProvider = Provider<LocationService>((ref) {
  final service = LocationService(
    heartbeatEvery: ref.watch(locationHeartbeatProvider),
    prefs: ref.watch(prefsProvider),
    post: (lat, lng) => ref.read(riderRepoProvider).postLocation(lat, lng),
    onServerOffline: () => ref.invalidate(meProvider),
  );
  ref.onDispose(() => unawaited(service.stop()));

  ref.listen(userIdProvider, (prev, next) {
    if (prev != next) unawaited(service.stop());
  });
  ref.listen(meProvider, (_, next) {
    final e = next.error;
    // 401 -> /login, 403 -> /not-rider. Other failures keep the rider online.
    if (e is ApiException && (e.status == 401 || e.status == 403)) {
      unawaited(service.stop());
    }
  });
  ref.listen<RiderAvailabilityDto>(availabilityProvider, (_, a) {
    if (!a.isOnline) {
      if (service.running) unawaited(service.stop());
      return;
    }
    final active = ref.read(meProvider).value?.activeDeliveryId != null;
    unawaited(service.resume(activeDelivery: active));
  }, fireImmediately: true);
  return service;
});
