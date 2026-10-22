import 'dart:io';

import '../core/api.dart';
import '../models/support.dart';

/// Safety: `POST /api/rider/sos` and the rider's emergency contact.
/// [ApiSafetyRepository] talks to the website; a debug build can swap in the
/// fixture backend (data/fixtures/fixture_support.dart).
abstract interface class SafetyRepository {
  /// Alerts Deligro ops. Returns only when the server took it (200 or 201);
  /// every other answer throws [ApiException] (status 0 = no connection), and
  /// the caller must not say ops were alerted.
  Future<SosAck> sos({
    required SosKind kind,
    double? lat,
    double? lng,
    String? note,
    String? orderId,
    List<File> photos = const [],
  });

  /// The rider's emergency contact (`GET /api/rider/profile`), or null.
  Future<EmergencyContact?> emergencyContact();
}

class ApiSafetyRepository implements SafetyRepository {
  ApiSafetyRepository(this._api);

  final ApiClient _api;

  @override
  Future<SosAck> sos({
    required SosKind kind,
    double? lat,
    double? lng,
    String? note,
    String? orderId,
    List<File> photos = const [],
  }) async {
    final hasFix = lat != null && lng != null;
    final trimmed = (note ?? '').trim();
    final Map<String, dynamic> res;
    if (photos.isEmpty) {
      res = await _api.post('/api/rider/sos', {
        'kind': kind.wire,
        if (hasFix) 'lat': lat,
        if (hasFix) 'lng': lng,
        if (trimmed.isNotEmpty) 'note': trimmed,
        'orderId': ?orderId,
      });
    } else {
      res = await _api.postMultipart(
        '/api/rider/sos',
        {
          'kind': kind.wire,
          if (hasFix) 'lat': '$lat',
          if (hasFix) 'lng': '$lng',
          if (trimmed.isNotEmpty) 'note': trimmed,
          'orderId': ?orderId,
        },
        'photos',
        photos,
      );
    }
    if (res['ok'] != true) throw ApiException(500, 'bad_response');
    return SosAck.fromJson(res);
  }

  @override
  Future<EmergencyContact?> emergencyContact() async {
    final res = await _api.get('/api/rider/profile');
    final profile = res['profile'];
    if (profile is! Map) return null;
    final contact = EmergencyContact.fromJson(profile['emergency']);
    return contact.hasPhone ? contact : null;
  }
}
