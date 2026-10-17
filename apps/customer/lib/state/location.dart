import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;

import '../core/geo.dart';
import 'prefs.dart';

class DeliveryLocation {
  const DeliveryLocation({
    required this.lat,
    required this.lng,
    required this.label,
    this.sublabel,
    this.addressId,
    this.isFallback = false,
  });

  final double lat;
  final double lng;

  /// Short area name ("Station Road") for the header chip.
  final String label;
  final String? sublabel;

  /// Set when the customer picked one of their saved addresses.
  final String? addressId;

  /// True while we are showing the launch-city centre, not a real fix.
  final bool isFallback;

  static const pinned = DeliveryLocation(
    lat: pinnedLat,
    lng: pinnedLng,
    label: pinnedLabel,
    sublabel: 'Chhattisgarh',
    isFallback: true,
  );

  Map<String, dynamic> toJson() => {
        'lat': lat,
        'lng': lng,
        'label': label,
        'sublabel': sublabel,
        'addressId': addressId,
      };

  factory DeliveryLocation.fromJson(Map<String, dynamic> j) => DeliveryLocation(
        lat: (j['lat'] as num).toDouble(),
        lng: (j['lng'] as num).toDouble(),
        label: '${j['label']}',
        sublabel: j['sublabel'] as String?,
        addressId: j['addressId'] as String?,
      );
}

enum LocateResult { ok, serviceOff, denied, deniedForever, failed }

class LocationNotifier extends Notifier<DeliveryLocation> {
  static const _key = 'deligro-location';

  @override
  DeliveryLocation build() {
    final raw = ref.read(prefsProvider).getString(_key);
    if (raw == null) return DeliveryLocation.pinned;
    try {
      return DeliveryLocation.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return DeliveryLocation.pinned;
    }
  }

  void set(DeliveryLocation loc) {
    state = loc;
    ref.read(prefsProvider).setString(_key, jsonEncode(loc.toJson()));
  }

  /// GPS fix → reverse-geocoded label. Leaves the current location alone on
  /// any failure and says why, so the screen can explain it.
  Future<LocateResult> detect() async {
    final fix = await currentPosition();
    if (fix.result != LocateResult.ok) return fix.result;
    final p = fix.position!;
    final place = await reverseGeocode(p.latitude, p.longitude);
    set(DeliveryLocation(
      lat: p.latitude,
      lng: p.longitude,
      label: place?.label ?? 'Current location',
      sublabel: place?.sublabel,
    ));
    return LocateResult.ok;
  }
}

final locationProvider =
    NotifierProvider<LocationNotifier, DeliveryLocation>(LocationNotifier.new);

Future<({LocateResult result, Position? position})> currentPosition() async {
  try {
    if (!await Geolocator.isLocationServiceEnabled()) {
      return (result: LocateResult.serviceOff, position: null);
    }
    var perm = await Geolocator.checkPermission();
    if (perm == LocationPermission.denied) {
      perm = await Geolocator.requestPermission();
    }
    if (perm == LocationPermission.deniedForever) {
      return (result: LocateResult.deniedForever, position: null);
    }
    if (perm == LocationPermission.denied) {
      return (result: LocateResult.denied, position: null);
    }
    final p = await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.high,
        timeLimit: Duration(seconds: 15),
      ),
    );
    return (result: LocateResult.ok, position: p);
  } catch (_) {
    return (result: LocateResult.failed, position: null);
  }
}

/// Best-effort area name for a coordinate, via OpenStreetMap Nominatim.
/// (The website's Google key is referrer-restricted to the browser, so it
/// cannot be used from the app.) Null on any failure; callers say
/// "Current location".
Future<({String label, String? sublabel, String line})?> reverseGeocode(
  double lat,
  double lng,
) async {
  try {
    final res = await http.get(
      Uri.https('nominatim.openstreetmap.org', '/reverse', {
        'format': 'jsonv2',
        'lat': '$lat',
        'lon': '$lng',
        'zoom': '17',
        'addressdetails': '1',
      }),
      headers: {
        'User-Agent': 'DeligroCustomer/2.0 (com.ractrotech.deligro)',
        'Accept-Language': 'en',
      },
    ).timeout(const Duration(seconds: 8));
    if (res.statusCode != 200) return null;
    final j = jsonDecode(res.body) as Map<String, dynamic>;
    final a = (j['address'] as Map?) ?? const {};
    String? first(List<String> keys) {
      for (final k in keys) {
        final v = a[k];
        if (v is String && v.isNotEmpty) return v;
      }
      return null;
    }

    final area = first(['road', 'neighbourhood', 'suburb', 'village', 'town', 'city']);
    final city = first(['city', 'town', 'village', 'county', 'state_district']);
    final state = first(['state']);
    final sub = [if (city != null && city != area) city, ?state].join(', ');
    return (
      label: area ?? city ?? 'Current location',
      sublabel: sub.isEmpty ? null : sub,
      line: '${j['display_name'] ?? ''}',
    );
  } catch (_) {
    return null;
  }
}
