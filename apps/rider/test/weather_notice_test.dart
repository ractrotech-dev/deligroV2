import 'package:deligro_rider/features/home/weather_notice_card.dart';
import 'package:deligro_rider/models/dashboard.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  test('the dashboard reads the weather of the rider\'s zones; an older server sends none', () {
    final d = RiderDashboard.fromJson({
      'weather': [
        {'zone': 'Bemetara', 'level': 'storm', 'title': 'Storm in Bemetara', 'body': 'Take shelter if it is unsafe to ride.'},
      ],
    });
    expect(d.weather.single.title, 'Storm in Bemetara');
    expect(RiderDashboard.fromJson(const {}).weather, isEmpty);
  });

  testWidgets('the card shows what to do', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.light),
      home: const Scaffold(
        body: WeatherNoticeCard(notice: WeatherNotice(level: 'rain', title: 'Rain in Bemetara', body: 'Ride carefully.')),
      ),
    ));
    expect(find.text('Rain in Bemetara'), findsOneWidget);
    expect(find.text('Ride carefully.'), findsOneWidget);
  });
}
