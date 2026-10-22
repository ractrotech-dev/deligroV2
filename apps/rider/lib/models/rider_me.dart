import 'profile.dart' show ProfileStatus;

/// The rider's availability row (`RiderAvailability` in
/// src/lib/rider/availability.ts): all instants are ISO strings on the wire.
class RiderAvailabilityDto {
  const RiderAvailabilityDto({
    required this.isOnline,
    this.breakUntil,
    this.onlineSince,
    this.lastFixAt,
  });

  final bool isOnline;
  final DateTime? breakUntil;
  final DateTime? onlineSince;
  final DateTime? lastFixAt;

  factory RiderAvailabilityDto.fromJson(Map<String, dynamic> j) => RiderAvailabilityDto(
        isOnline: j['isOnline'] == true,
        breakUntil: _date(j['breakUntil']),
        onlineSince: _date(j['onlineSince']),
        lastFixAt: _date(j['lastFixAt']),
      );

  static const offline = RiderAvailabilityDto(isOnline: false);
}

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v) : null;

/// `GET /api/rider/me`.
class RiderMe {
  const RiderMe({
    required this.id,
    this.name,
    this.phone,
    this.avatarUrl,
    this.riderCode,
    required this.availability,
    required this.phase,
    this.activeDeliveryId,
    this.features = const {},
    this.privacyUrl,
    this.termsUrl,
    this.profile,
  });

  final String id;
  final String? name;
  final String? phone;
  final String? avatarUrl;

  /// The rider's ID (`DR-0042`). Null on a database without migration 0081.
  final String? riderCode;
  final RiderAvailabilityDto availability;

  /// `offline` | `online` | `break` | `stale`, as the server computes it.
  final String phase;
  final String? activeDeliveryId;

  /// `driver.history`, `driver.earnings`, … The server sends `false` only for
  /// a switch that is off; read with [feature].
  final Map<String, bool> features;
  final String? privacyUrl;
  final String? termsUrl;

  /// Verification and whether the profile needs the rider (Phase 6). Null on a
  /// server without migration 0086.
  final ProfileStatus? profile;

  /// A switch is on unless the server says otherwise.
  bool feature(String key) => features[key] ?? true;

  factory RiderMe.fromJson(Map<String, dynamic> j) {
    final legal = j['legal'] is Map
        ? Map<String, dynamic>.from(j['legal'] as Map)
        : const <String, dynamic>{};
    final features = j['features'] is Map
        ? Map<String, dynamic>.from(j['features'] as Map)
        : const <String, dynamic>{};
    return RiderMe(
      id: '${j['id']}',
      name: j['name'] as String?,
      phone: j['phone'] as String?,
      avatarUrl: j['avatarUrl'] as String?,
      riderCode: j['riderCode'] as String?,
      availability: j['availability'] is Map
          ? RiderAvailabilityDto.fromJson(Map<String, dynamic>.from(j['availability'] as Map))
          : RiderAvailabilityDto.offline,
      phase: '${j['phase'] ?? 'offline'}',
      activeDeliveryId: j['activeDeliveryId'] as String?,
      features: {for (final e in features.entries) e.key: e.value != false},
      privacyUrl: legal['privacyUrl'] as String?,
      termsUrl: legal['termsUrl'] as String?,
      profile: ProfileStatus.fromJson(j['profile']),
    );
  }
}
