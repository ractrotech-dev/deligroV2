import '../core/api.dart';
import '../models/outcome.dart';

/// One zone's weather (`/api/manager/weather`, 0178): what customers and
/// riders are told now, the automatic reading, and any override.
class ZoneWeatherRow {
  const ZoneWeatherRow({
    required this.zoneId,
    required this.zoneName,
    required this.level,
    required this.autoLevel,
    this.autoDetail,
    this.autoCheckedAt,
    this.manualLevel,
    this.manualUntil,
    this.manualNote,
  });

  factory ZoneWeatherRow.fromJson(Map<String, dynamic> j) {
    DateTime? at(Object? v) => v is String ? DateTime.tryParse(v) : null;
    return ZoneWeatherRow(
      zoneId: '${j['zoneId']}',
      zoneName: '${j['zoneName'] ?? ''}',
      level: '${j['level'] ?? 'clear'}',
      autoLevel: '${j['autoLevel'] ?? 'clear'}',
      autoDetail: j['autoDetail'] as String?,
      autoCheckedAt: at(j['autoCheckedAt']),
      manualLevel: j['manualLevel'] as String?,
      manualUntil: at(j['manualUntil']),
      manualNote: j['manualNote'] as String?,
    );
  }

  final String zoneId;
  final String zoneName;

  /// What customers and riders are told now.
  final String level;
  final String autoLevel;
  final String? autoDetail;
  final DateTime? autoCheckedAt;
  final String? manualLevel;
  final DateTime? manualUntil;
  final String? manualNote;
}

/// The levels, with the words and minutes customers see (src/lib/weather/levels.ts).
const weatherLevels = <(String, String, String)>[
  ('clear', 'Clear', 'No notice, normal delivery times'),
  ('rain', 'Rain', '+10 min'),
  ('heavy_rain', 'Heavy rain', '+20 min'),
  ('storm', 'Storm', '+30 min'),
  ('heat', 'Very hot', '+5 min'),
];

String weatherLabel(String level) =>
    weatherLevels.firstWhere((l) => l.$1 == level, orElse: () => (level, level, '')).$2;

abstract interface class WeatherRepository {
  Future<List<ZoneWeatherRow>> list();

  /// [level] `auto` goes back to the automatic reading; otherwise [hours] 1–12.
  Future<Outcome<List<ZoneWeatherRow>>> set({
    required String zoneId,
    required String level,
    int? hours,
    String? note,
    required String clientActionId,
  });
}

List<ZoneWeatherRow> _rows(Map<String, dynamic> res) => [
  for (final z in (res['zones'] as List? ?? const [])) if (z is Map) ZoneWeatherRow.fromJson(z.cast<String, dynamic>()),
];

class ApiWeatherRepository implements WeatherRepository {
  ApiWeatherRepository(this._api);
  final ApiClient _api;

  @override
  Future<List<ZoneWeatherRow>> list() async => _rows(await _api.get('/api/manager/weather'));

  @override
  Future<Outcome<List<ZoneWeatherRow>>> set({
    required String zoneId,
    required String level,
    int? hours,
    String? note,
    required String clientActionId,
  }) =>
      runAction(
        () => _api.post('/api/manager/weather', {
          'zoneId': zoneId,
          'level': level,
          'hours': ?hours,
          'note': ?note,
          'clientActionId': clientActionId,
        }),
        _rows,
      );
}
