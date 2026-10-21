import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/jobs.dart';

/// The delivery the rider is carrying, kept on the phone so the delivery screen
/// still opens, with its numbers and codes to type, when the signal drops
/// mid-job. The board refresh rewrites it; an unreadable copy is no copy.
class ActiveDeliveryCache {
  ActiveDeliveryCache(this._prefs);

  static const key = 'active_delivery_v1';

  final SharedPreferences _prefs;

  Future<void> save(RiderActive a) => _prefs.setString(key, jsonEncode(a.toJson()));

  RiderActive? load() {
    final raw = _prefs.getString(key);
    if (raw == null) return null;
    try {
      return RiderActive.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> clear() => _prefs.remove(key);
}
