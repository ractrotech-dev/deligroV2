import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';

import '../core/api.dart';
import '../core/location_service.dart';
import '../core/sos_queue.dart';
import '../data/fixtures/fixture_backend.dart';
import '../data/fixtures/fixture_support.dart';
import '../data/safety_repository.dart';
import '../models/support.dart';
import 'prefs.dart';
import 'providers.dart';

/// The SOS route and the rider's emergency contact, or in a debug build
/// started with FIXTURES=true the in-memory fixture backend (`fixturesEnabled`
/// is a compile-time false in a release build, so none of it ships).
final safetyRepoProvider = Provider<SafetyRepository>((ref) {
  if (fixturesEnabled) return FixtureSafetyRepository.create();
  return ApiSafetyRepository(ref.watch(apiProvider));
});

typedef LastKnownPosition = Future<({double lat, double lng})?> Function();

Future<({double lat, double lng})?> _lastKnown() async {
  try {
    final p = await Geolocator.getLastKnownPosition().timeout(const Duration(seconds: 2));
    return p == null ? null : (lat: p.latitude, lng: p.longitude);
  } catch (_) {
    return null;
  }
}

/// The phone's last known position, for an alert pressed when the app has no
/// reading of its own. Tests replace it.
final lastKnownPositionProvider = Provider<LastKnownPosition>((_) => _lastKnown);

/// "Alert Deligro" that keeps trying until the server confirms
/// (core/sos_queue.dart). Kept alive so a retry goes on after the sheet is
/// closed.
final sosQueueProvider = Provider<SosQueue>((ref) {
  final queue = SosQueue(
    ref.watch(safetyRepoProvider),
    ref.watch(prefsProvider),
    position: () {
      final fix = ref.read(latestFixProvider);
      return fix == null ? null : (lat: fix.lat, lng: fix.lng);
    },
  );
  ref.onDispose(queue.dispose);
  return queue;
});

final sosStatusProvider = StreamProvider<SosStatus>((ref) => ref.watch(sosQueueProvider).status);

/// The position to send with an alert: the live reading, else the phone's last
/// known one. Null when there is neither (the alert goes without).
Future<({double lat, double lng})?> alertPosition(WidgetRef ref) async {
  final fix = ref.read(latestFixProvider);
  if (fix != null) return (lat: fix.lat, lng: fix.lng);
  return ref.read(lastKnownPositionProvider)();
}

const _emergencyKey = 'emergency_contact_v1';

/// The rider's emergency contact. A copy is kept on the phone, so the call
/// still works with no signal; null when none is saved.
final emergencyContactProvider = FutureProvider.autoDispose<EmergencyContact?>(
  retry: (_, _) => null,
  (ref) async {
    final prefs = ref.read(prefsProvider);
    EmergencyContact? saved() {
      try {
        final raw = prefs.getString(_emergencyKey);
        if (raw == null) return null;
        final c = EmergencyContact.fromJson(jsonDecode(raw));
        return c.hasPhone ? c : null;
      } catch (_) {
        return null;
      }
    }

    Future<EmergencyContact?> refresh() async {
      try {
        final fresh = await ref.read(safetyRepoProvider).emergencyContact();
        if (fresh == null) {
          await prefs.remove(_emergencyKey);
        } else {
          await prefs.setString(_emergencyKey, jsonEncode(fresh.toJson()));
        }
        return fresh;
      } on ApiException {
        return saved();
      }
    }

    // The copy on the phone answers at once; the server's word is fetched
    // behind it for next time. With no copy, the server is waited for.
    final kept = saved();
    if (kept != null) {
      unawaited(refresh());
      return kept;
    }
    return refresh();
  },
);
