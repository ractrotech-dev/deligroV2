import 'package:deligro_customer/core/pricing.dart';
import 'package:deligro_customer/features/home/home_screen.dart';
import 'package:deligro_customer/models/restaurant.dart';
import 'package:deligro_customer/models/weather.dart';
import 'package:deligro_customer/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  test('weather adds its minutes to the band, on top of a busy bump', () {
    final p = kitchenPace(etaMin: 25, etaMax: 35, weatherExtraMinutes: 20);
    expect((p.etaMin, p.etaMax, p.weatherMinutes), (45, 55, 20));
    final both = kitchenPace(
      etaMin: 25,
      etaMax: 35,
      busyUntil: DateTime.now().add(const Duration(minutes: 10)),
      busyExtraMinutes: 10,
      weatherExtraMinutes: 10,
    );
    expect((both.etaMin, both.etaMax, both.busy), (45, 55, true));
  });

  test('a restaurant row picks up its zone weather', () {
    final r = Restaurant.fromRow({'id': 'r1', 'slug': 's', 'name': 'Spice Hub', 'eta_min': 20, 'eta_max': 30}, weatherMinutes: 10);
    expect((r.etaMin, r.etaMax), (30, 40));
  });

  test('the customer text matches the site', () {
    const w = ZoneWeather(zoneName: 'Bemetara', level: 'rain', extraMinutes: 10);
    expect(w.message, 'Rain in Bemetara: deliveries may take about 10 minutes longer.');
    expect(ZoneWeather.fromRow(const {'zone_name': 'B', 'level': 'storm', 'extra_minutes': 30}).message, contains('30 minutes'));
  });

  testWidgets('the home banner says what is happening', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.light),
      home: const Scaffold(body: WeatherBanner(notices: [ZoneWeather(zoneName: 'Bemetara', level: 'storm', extraMinutes: 30)])),
    ));
    expect(find.textContaining('Storm in Bemetara'), findsOneWidget);
  });
}
