import 'dart:async';
import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/jobs.dart';

/// The delivery the rider is carrying, kept on the phone so the delivery screen
/// still opens, with its numbers and codes to type, when the signal drops
/// mid-job. The board refresh rewrites it; an unreadable copy is no copy.
///
/// [changes] is how the rest of the app hears what the board said: the
/// location service shares every 10 s while it carries a live delivery and
/// steps back to 30 s once the board says there is none.
class ActiveDeliveryCache {
  ActiveDeliveryCache(this._prefs);

  static const key = 'active_delivery_v1';

  final SharedPreferences _prefs;

  final _changes = StreamController<RiderActive?>.broadcast();

  /// The delivery after every [save] (and null after every [clear]), including
  /// a save of the same delivery: each one is the board saying so again.
  Stream<RiderActive?> get changes => _changes.stream;

  Future<void> save(RiderActive a) async {
    await _prefs.setString(key, jsonEncode(a.toJson()));
    if (!_changes.isClosed) _changes.add(a);
  }

  RiderActive? load() {
    final raw = _prefs.getString(key);
    if (raw == null) return null;
    try {
      return RiderActive.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> clear() async {
    await _prefs.remove(key);
    if (!_changes.isClosed) _changes.add(null);
  }

  void dispose() => _changes.close();
}
