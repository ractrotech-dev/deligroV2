import 'package:flutter/foundation.dart';

import '../core/api.dart';
import '../models/rider_me.dart';

/// The `/api/rider/*` routes (src/app/api/rider).
class RiderRepository {
  RiderRepository(this._api);

  final ApiClient _api;

  /// 401 unauthenticated, 403 not_rider, 503 not_configured, 404 on a server
  /// that predates the rider routes: all arrive as an [ApiException].
  Future<RiderMe> me() async => RiderMe.fromJson(await _api.get('/api/rider/me'));

  /// [action] is `online`, `offline`, `break` or `resume`. A break always
  /// sends `minutes`: 15, 30 or 60, or null for "until I resume" (the server
  /// reads a missing `minutes` as an invalid body, not as "until resumed").
  /// 409 `active_delivery` / `not_online` and 503 `migration_pending` throw.
  Future<RiderAvailabilityDto> setStatus(String action, {int? minutes}) async {
    final res = await _api.post('/api/rider/status', {
      'action': action,
      if (action == 'break') 'minutes': minutes,
    });
    return RiderAvailabilityDto.fromJson(Map<String, dynamic>.from(res['availability'] as Map));
  }

  /// `online` is whether the rider is online (an offline fix is dropped);
  /// `active` whether a delivery is in flight.
  Future<({bool online, bool active})> postLocation(double lat, double lng) async {
    final res = await _api.post('/api/rider/location', {'lat': lat, 'lng': lng});
    return (online: res['online'] == true, active: res['active'] == true);
  }

  /// Takes the rider offline just before the session ends. Best effort, and it
  /// never throws: a rider must always be able to sign out, so a 503
  /// `migration_pending`, any other refusal and a dead network are all
  /// swallowed (logged in debug) and the caller signs out regardless.
  Future<void> signoutOffline() async {
    try {
      await _api.post('/api/rider/signout');
    } catch (e) {
      debugPrint('rider signout (ignored): $e');
    }
  }
}
