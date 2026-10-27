/// Rain, a storm or heat in a delivery zone right now (0178's
/// `zone_weather_now()`), for the home banner. The extra minutes are already in
/// each shop's delivery time.
class ZoneWeather {
  const ZoneWeather({required this.zoneName, required this.level, required this.extraMinutes});

  factory ZoneWeather.fromRow(Map<String, dynamic> r) => ZoneWeather(
    zoneName: '${r['zone_name'] ?? ''}',
    level: '${r['level'] ?? 'clear'}',
    extraMinutes: (r['extra_minutes'] as num?)?.toInt() ?? 0,
  );

  final String zoneName;

  /// `rain`, `heavy_rain`, `storm` or `heat`.
  final String level;
  final int extraMinutes;

  /// The same words as the site (src/lib/weather/levels.ts customerWeatherText).
  String get message => switch (level) {
    'rain' => 'Rain in $zoneName: deliveries may take about 10 minutes longer.',
    'heavy_rain' => 'Heavy rain in $zoneName: deliveries may take about 20 minutes longer.',
    'storm' => 'Storm in $zoneName: deliveries may take about 30 minutes longer.',
    'heat' => 'Very hot in $zoneName: deliveries may take a little longer.',
    _ => '',
  };
}
