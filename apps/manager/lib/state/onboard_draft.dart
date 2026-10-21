import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

import '../models/vendors.dart';
import 'prefs.dart';

/// Where an unfinished onboarding is kept on the phone until it is submitted
/// or discarded. Never holds the password.
const onboardDraftKey = 'manager-onboard-draft';

class OnboardDraftNotifier extends Notifier<OnboardDraft> {
  @override
  OnboardDraft build() {
    final raw = ref.read(prefsProvider).getString(onboardDraftKey);
    if (raw == null) return const OnboardDraft();
    try {
      return OnboardDraft.fromJson((jsonDecode(raw) as Map).cast<String, dynamic>());
    } catch (_) {
      return const OnboardDraft();
    }
  }

  void update(OnboardDraft next) {
    state = next;
    ref.read(prefsProvider).setString(onboardDraftKey, jsonEncode(next.toSaved()));
  }

  void clear() {
    state = const OnboardDraft();
    ref.read(prefsProvider).remove(onboardDraftKey);
  }

  bool get hasDraft => ref.read(prefsProvider).containsKey(onboardDraftKey);
}

final onboardDraftProvider = NotifierProvider<OnboardDraftNotifier, OnboardDraft>(OnboardDraftNotifier.new);

/// The phone's position, asking for permission if needed; null when refused
/// or unavailable. One seam so tests can stand somewhere.
final currentLocationProvider = Provider<Future<LatLng?> Function()>((_) => () async {
      try {
        if (!await Geolocator.isLocationServiceEnabled()) return null;
        var p = await Geolocator.checkPermission();
        if (p == LocationPermission.denied) p = await Geolocator.requestPermission();
        if (p == LocationPermission.denied || p == LocationPermission.deniedForever) return null;
        final pos = await Geolocator.getCurrentPosition(
          locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 15)),
        );
        return LatLng(pos.latitude, pos.longitude);
      } catch (_) {
        return null;
      }
    });
