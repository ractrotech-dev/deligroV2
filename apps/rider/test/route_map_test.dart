import 'package:deligro_rider/features/delivery/route_map.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  testWidgets('the map keeps one tile provider across rebuilds', (tester) async {
    Future<void> show(double riderLat) => tester.pumpWidget(
          ProviderScope(
            overrides: [mapTilesEnabledProvider.overrideWithValue(true)],
            child: MaterialApp(
              theme: buildTheme(Brightness.light),
              home: Scaffold(
                body: RouteMap(
                  shop: (lat: 21.70, lng: 81.53),
                  drop: (lat: 21.71, lng: 81.54),
                  rider: (lat: riderLat, lng: 81.535),
                ),
              ),
            ),
          ),
        );
    await show(21.700);
    final first = tester.widget<TileLayer>(find.byType(TileLayer)).tileProvider;
    // A new GPS fix rebuilds the map.
    await show(21.705);
    expect(identical(tester.widget<TileLayer>(find.byType(TileLayer)).tileProvider, first), isTrue);
    await tester.pumpWidget(const SizedBox());
  });
}
