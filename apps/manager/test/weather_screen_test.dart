import 'package:deligro_manager/data/weather_repository.dart';
import 'package:deligro_manager/features/weather/weather_screen.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'vp_helpers.dart';

class _FakeWeather implements WeatherRepository {
  final calls = <({String zoneId, String level, int? hours})>[];
  List<ZoneWeatherRow> rows = [
    ZoneWeatherRow(
      zoneId: 'z-1',
      zoneName: 'Bemetara',
      level: 'rain',
      autoLevel: 'rain',
      autoCheckedAt: DateTime.utc(2026, 10, 27, 8, 0),
    ),
  ];

  @override
  Future<List<ZoneWeatherRow>> list() async => rows;

  @override
  Future<Outcome<List<ZoneWeatherRow>>> set({
    required String zoneId,
    required String level,
    int? hours,
    String? note,
    required String clientActionId,
  }) async {
    calls.add((zoneId: zoneId, level: level, hours: hours));
    return Applied(rows);
  }
}

void main() {
  test('a zone row reads the override and the reading', () {
    final z = ZoneWeatherRow.fromJson(const {
      'zoneId': 'z', 'zoneName': 'B', 'level': 'storm', 'autoLevel': 'rain',
      'manualLevel': 'storm', 'manualUntil': '2026-10-27T10:00:00Z', 'autoCheckedAt': null,
    });
    expect((z.level, z.manualLevel, z.autoCheckedAt), ('storm', 'storm', null));
    expect(z.manualUntil, DateTime.utc(2026, 10, 27, 10));
    expect(weatherLabel('heavy_rain'), 'Heavy rain');
  });

  testWidgets('shows each zone; setting storm for 3 hours sends it', (tester) async {
    final fake = _FakeWeather();
    await pumpVp(tester, const WeatherScreen(),
        permissions: const {'manager.weather.manage'}, extra: [weatherRepoProvider.overrideWithValue(fake)]);
    await tester.pumpAndSettle();
    expect(find.text('Bemetara'), findsOneWidget);
    expect(find.text('Now: Rain'), findsOneWidget);
    await tester.tap(find.byKey(const Key('weather-set-z-1')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Storm').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('3 hours'));
    await tester.pumpAndSettle();
    expect(fake.calls.single, (zoneId: 'z-1', level: 'storm', hours: 3));
  });

  testWidgets('without Weather notices a manager can look but not set', (tester) async {
    await pumpVp(tester, const WeatherScreen(), permissions: const {'manager.orders.view'},
        extra: [weatherRepoProvider.overrideWithValue(_FakeWeather())]);
    await tester.pumpAndSettle();
    expect(find.text('Bemetara'), findsOneWidget);
    expect(find.byKey(const Key('weather-set-z-1')), findsNothing);
  });
}
