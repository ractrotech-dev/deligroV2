/// `GET /api/manager/me` — who is signed in, which zones they work, and what
/// they may do. The server decides all of it; the app only hides what the
/// answer says is off.
class ManagerMe {
  const ManagerMe({required this.profile, required this.zones, required this.permissions});

  final ManagerProfile profile;
  final ZoneSet zones;
  final Map<String, bool> permissions;

  bool get isAdmin => profile.role == 'admin';

  /// Whether a `manager.*` permission is on. Unknown keys are off.
  bool can(String key) => permissions[key] ?? false;

  /// A manager with no zones sees nothing; the app says so.
  bool get hasNoZones => !zones.all && zones.cities.isEmpty;

  factory ManagerMe.fromJson(Map<String, dynamic> j) {
    final perms = (j['permissions'] as Map?) ?? const {};
    return ManagerMe(
      profile: ManagerProfile.fromJson((j['profile'] as Map?)?.cast<String, dynamic>() ?? const {}),
      zones: ZoneSet.fromJson((j['zones'] as Map?)?.cast<String, dynamic>() ?? const {}),
      permissions: {
        for (final e in perms.entries)
          if (e.value is bool) '${e.key}': e.value as bool,
      },
    );
  }
}

class ManagerProfile {
  const ManagerProfile({
    required this.id,
    required this.fullName,
    required this.phone,
    required this.email,
    required this.role,
  });

  final String id;
  final String? fullName;
  final String? phone;
  final String? email;
  final String role;

  String get displayName => (fullName?.trim().isNotEmpty ?? false) ? fullName!.trim() : 'Manager';

  factory ManagerProfile.fromJson(Map<String, dynamic> j) => ManagerProfile(
        id: '${j['id'] ?? ''}',
        fullName: j['fullName'] as String?,
        phone: j['phone'] as String?,
        email: j['email'] as String?,
        role: '${j['role'] ?? 'manager'}',
      );
}

class ZoneSet {
  const ZoneSet({required this.all, required this.cities});

  /// True for an admin: every zone, now and future.
  final bool all;
  final List<City> cities;

  List<Zone> get zones => [for (final c in cities) ...c.zones];

  factory ZoneSet.fromJson(Map<String, dynamic> j) => ZoneSet(
        all: j['all'] == true,
        cities: [
          for (final c in (j['cities'] as List?) ?? const [])
            if (c is Map) City.fromJson(c.cast<String, dynamic>()),
        ],
      );
}

class City {
  const City({required this.id, required this.name, required this.zones});
  final String id;
  final String name;
  final List<Zone> zones;

  factory City.fromJson(Map<String, dynamic> j) => City(
        id: '${j['id']}',
        name: '${j['name'] ?? ''}',
        zones: [
          for (final z in (j['zones'] as List?) ?? const [])
            if (z is Map) Zone.fromJson(z.cast<String, dynamic>(), cityName: '${j['name'] ?? ''}'),
        ],
      );
}

class Zone {
  const Zone({required this.id, required this.name, required this.slug, required this.cityName, this.isDefault = false});
  final String id;
  final String name;
  final String slug;
  final String cityName;
  final bool isDefault;

  factory Zone.fromJson(Map<String, dynamic> j, {required String cityName}) => Zone(
        id: '${j['id']}',
        name: '${j['name'] ?? ''}',
        slug: '${j['slug'] ?? ''}',
        cityName: cityName,
        isDefault: j['isDefault'] == true,
      );
}
