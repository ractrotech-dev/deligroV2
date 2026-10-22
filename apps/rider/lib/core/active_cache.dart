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
  ActiveDeliveryCache(this._prefs, {this.ownerUid});

  static const key = 'active_delivery_v1';

  /// Who the saved delivery belongs to, so a rider who signs in on this phone
  /// after another is never offered the last rider's order.
  static const ownerKey = 'active_delivery_owner_v1';

  /// The signed-in user's id, asked afresh each time. Null (or no owner saved,
  /// as in a copy from an older build) means no check.
  final String? Function()? ownerUid;

  final SharedPreferences _prefs;

  final _changes = StreamController<RiderActive?>.broadcast();

  /// The delivery after every [save] (and null after every [clear]), including
  /// a save of the same delivery: each one is the board saying so again.
  Stream<RiderActive?> get changes => _changes.stream;

  Future<void> save(RiderActive a) async {
    await _prefs.setString(key, jsonEncode(a.toJson()));
    final uid = ownerUid?.call();
    if (uid != null) await _prefs.setString(ownerKey, uid);
    if (!_changes.isClosed) _changes.add(a);
  }

  RiderActive? load() {
    final raw = _prefs.getString(key);
    if (raw == null) return null;
    final uid = ownerUid?.call();
    final owner = _prefs.getString(ownerKey);
    // Someone else's delivery: not shown, and let go.
    if (uid != null && owner != null && owner != uid) {
      unawaited(_prefs.remove(key));
      unawaited(_prefs.remove(ownerKey));
      return null;
    }
    try {
      return RiderActive.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  Future<void> clear() async {
    await _prefs.remove(key);
    await _prefs.remove(ownerKey);
    if (!_changes.isClosed) _changes.add(null);
  }

  void dispose() => _changes.close();
}
