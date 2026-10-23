import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';
import '../core/location_service.dart';
import '../core/sos_queue.dart';
import '../data/fixtures/fixture_backend.dart';
import '../data/fixtures/fixture_support.dart';
import '../data/safety_repository.dart';
import '../data/support_repository.dart';
import '../models/support.dart';
import 'clock.dart';
import 'prefs.dart';
import 'providers.dart';
import 'support.dart' show saveSupportContact;
import 'user_data.dart';

/// The SOS route and the rider's emergency contact, or in a debug build
/// started with FIXTURES=true the in-memory fixture backend (`fixturesEnabled`
/// is a compile-time false in a release build, so none of it ships).
final safetyRepoProvider = Provider<SafetyRepository>((ref) {
  if (fixturesEnabled) return FixtureSafetyRepository.create();
  return ApiSafetyRepository(ref.watch(apiProvider));
});

typedef CurrentPosition = Future<SosPosition?> Function();

Future<SosPosition?> _currentPosition() async {
  try {
    final p = await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(accuracy: LocationAccuracy.high),
    ).timeout(sosPositionWait);
    return (lat: p.latitude, lng: p.longitude);
  } catch (_) {
    // No permission, no signal from the sky, or too slow: no position.
    return null;
  }
}

/// A new reading from the phone, for an alert pressed when the app has no
/// recent one. Null when there is none. Tests replace it.
final currentPositionProvider = Provider<CurrentPosition>((_) => _currentPosition);

/// The position to send with an alert: the live reading if it is at most two
/// minutes old, else a new reading (waiting up to five seconds), else null,
/// and the alert goes without a position. An old reading is never passed off
/// as the rider's location now.
Future<SosPosition?> freshPosition({
  required RiderFix? fix,
  required DateTime now,
  required CurrentPosition current,
}) async {
  if (fix != null && now.difference(fix.at) <= sosPositionFresh) return (lat: fix.lat, lng: fix.lng);
  return current();
}

/// [freshPosition] from inside a widget.
Future<SosPosition?> alertPosition(WidgetRef ref) => freshPosition(
      fix: ref.read(latestFixProvider),
      now: ref.read(clockProvider)(),
      current: ref.read(currentPositionProvider),
    );

/// "Alert Deligro" that keeps trying until the server confirms
/// (core/sos_queue.dart). Kept alive so a retry goes on after the sheet is
/// closed. It belongs to the signed-in user: a sign-out or another user
/// signing in drops what is waiting, and a session the server refused is
/// retried only once the same user signs in again.
final sosQueueProvider = Provider<SosQueue>((ref) {
  final queue = SosQueue(
    ref.watch(safetyRepoProvider),
    ref.watch(prefsProvider),
    uid: () => ref.read(userIdProvider),
    clock: ref.read(clockProvider),
    position: () => freshPosition(
      fix: ref.read(latestFixProvider),
      now: ref.read(clockProvider)(),
      current: ref.read(currentPositionProvider),
    ),
  );
  ref.onDispose(queue.dispose);
  ref.listen<String?>(userIdProvider, (_, uid) => unawaited(queue.userChanged(uid)));
  try {
    ref.listen<AsyncValue<AuthState>>(authStateProvider, (_, next) {
      final s = next.value;
      if (s == null) return;
      if (s.event == AuthChangeEvent.signedIn || s.event == AuthChangeEvent.tokenRefreshed) {
        unawaited(queue.userChanged(s.session?.user.id));
      }
    });
  } catch (e) {
    debugPrint('sos queue: no auth events: $e');
  }
  return queue;
});

final sosStatusProvider = StreamProvider<SosStatus>((ref) => ref.watch(sosQueueProvider).status);

const _emergencyKey = 'emergency_contact_v1';

EmergencyContact? _savedContact(SharedPreferences prefs, String? uid) {
  try {
    final raw = readUserString(prefs, _emergencyKey, uid);
    if (raw == null) return null;
    final c = EmergencyContact.fromJson(jsonDecode(raw));
    return c.hasPhone ? c : null;
  } catch (_) {
    return null;
  }
}

/// Asks the server for the emergency contact and keeps the answer under [uid].
/// Returns what the server said (null: none saved), or the kept copy when it
/// could not be asked. [stillCurrent] is asked after the wait: when the signed-in
/// user has changed by then, the answer is dropped and nothing is written.
Future<EmergencyContact?> refreshEmergencyContact(
  SafetyRepository repo,
  SharedPreferences prefs,
  String? uid, {
  bool Function()? stillCurrent,
}) async {
  try {
    final fresh = await repo.emergencyContact();
    if (stillCurrent != null && !stillCurrent()) return null;
    if (fresh == null) {
      await removeUserString(prefs, _emergencyKey, uid);
    } else {
      await writeUserString(prefs, _emergencyKey, uid, jsonEncode(fresh.toJson()));
    }
    return fresh;
  } on ApiException {
    return _savedContact(prefs, uid);
  }
}

/// After the rider saved a new emergency contact on Profile: asks the server
/// for it, replaces the copy kept on the phone and drops the provider's value,
/// so the next SOS sheet shows the new contact and not the old one. Takes the
/// container, like `refreshProfileIn`, so it can run after the screen is gone.
/// A failed ask leaves the old copy standing, and the provider is dropped
/// either way.
Future<void> refreshEmergencyContactIn(ProviderContainer container) async {
  try {
    final uid = container.read(userIdProvider);
    await refreshEmergencyContact(
      container.read(safetyRepoProvider),
      container.read(prefsProvider),
      uid,
      stillCurrent: () => container.read(userIdProvider) == uid,
    );
  } catch (_) {
    // The copy from before stands.
  }
  container.invalidate(emergencyContactProvider);
}

/// Keeps what a first SOS made with no signal needs: Deligro's support number
/// and the rider's emergency contact. Best effort and silent: a failure only
/// means the copy from last time (or none) stands. The shell calls it when the
/// app starts and each time it comes back to the front.
Future<void> cacheOfflineEssentials({
  required SupportRepository support,
  required SafetyRepository safety,
  required SharedPreferences prefs,
  required String? uid,
  String? Function()? currentUid,
}) async {
  // The answers come back later; if someone else is signed in by then, they
  // are not kept.
  bool same() => currentUid == null || currentUid() == uid;
  try {
    final overview = await support.overview();
    if (same()) await saveSupportContact(prefs, overview.contact);
  } catch (_) {}
  try {
    await refreshEmergencyContact(safety, prefs, uid, stillCurrent: same);
  } catch (_) {}
}

/// The rider's emergency contact. A copy is kept on the phone (under their
/// user id), so the call still works with no signal; null when none is saved.
final emergencyContactProvider = FutureProvider.autoDispose.family<EmergencyContact?, String>(
  retry: (_, _) => null,
  (ref, riderKey) async {
    final prefs = ref.read(prefsProvider);
    final uid = riderKey.isEmpty ? null : riderKey;
    final repo = ref.read(safetyRepoProvider);
    // The copy on the phone answers at once; the server's word is fetched
    // behind it for next time. With no copy, the server is waited for.
    final kept = _savedContact(prefs, uid);
    if (kept != null) {
      unawaited(refreshEmergencyContact(repo, prefs, uid));
      return kept;
    }
    return refreshEmergencyContact(repo, prefs, uid);
  },
);
