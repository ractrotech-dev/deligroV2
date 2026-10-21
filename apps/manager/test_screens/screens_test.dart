// Screenshots of the Manager app's Phase 2 screens with sample data, for
// reviewing the look without a signed-in manager. Not part of `flutter test`
// (it lives outside test/) and not a regression gate: the images depend on
// this PC's fonts. Writes PNGs to test_screens/out/ (gitignored):
//
//   flutter test test_screens --update-goldens
//
// Text uses Segoe UI / Consolas from C:\Windows\Fonts in place of Inter /
// JetBrains Mono, so the layout is real; Hindi glyphs are not available here.
import 'dart:io';

import 'package:deligro_manager/features/home/home_screen.dart';
import 'package:deligro_manager/features/stats/stats_screen.dart';
import 'package:deligro_manager/models/dashboard.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/models/stats.dart';
import 'package:deligro_manager/state/dashboard.dart';
import 'package:deligro_manager/state/prefs.dart';
import 'package:deligro_manager/state/session.dart';
import 'package:deligro_manager/state/stats.dart';
import 'package:deligro_manager/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../test/auth_test.dart' show meJson;
import '../test/stats_fixture.dart';

Future<void> _loadFont(String family, List<String> files) async {
  final loader = FontLoader(family);
  for (final f in files) {
    final bytes = File(f.contains('/') ? f : 'C:/Windows/Fonts/$f').readAsBytesSync();
    loader.addFont(Future.value(ByteData.view(bytes.buffer)));
  }
  await loader.load();
}

Future<void> _fonts() async {
  for (final w in FontWeight.values) {
    final bold = w.value >= 600;
    await _loadFont(GoogleFonts.inter(fontWeight: w).fontFamily!, [bold ? 'segoeuib.ttf' : 'segoeui.ttf']);
    await _loadFont(GoogleFonts.jetBrainsMono(fontWeight: w).fontFamily!, [bold ? 'consolab.ttf' : 'consola.ttf']);
  }
  await _loadFont('Roboto', ['segoeui.ttf', 'segoeuib.ttf']);
  await _loadFont('MaterialIcons', ['F:/dev/flutter/bin/cache/artifacts/material_fonts/materialicons-regular.otf']);
}

class _FixedMe extends ManagerMeNotifier {
  @override
  Future<ManagerMe?> build() async => ManagerMe.fromJson({
        ...meJson,
        'permissions': {'manager.reports.view': true, 'manager.finance.view': true, 'manager.orders.view': true},
      });
}

class _FixedDashboard extends DashboardNotifier {
  @override
  Future<DashboardData> build() async => DashboardData.fromJson({
        'today': '2026-10-21',
        'generatedAt': DateTime.now().toUtc().toIso8601String(),
        'order': [for (final f in FigureKey.values) f.key],
        'figures': {
          'todaysTotalSales': 18640, 'totalSales': 1284560, 'todaysOrders': 74, 'totalOrders': 5231,
          'pendingOrders': 9, 'completedOrders': 5038, 'cancelledOrders': 184, 'activeVendors': 42,
          'onlineVendors': 31, 'activeRiders': 18, 'onlineRiders': 11, 'ridersOnDelivery': 6,
          'totalDeliveryFees': 142300, 'totalPlatformCommission': 186420, 'vendorPaymentsDue': 64210,
          'riderPaymentsDue': null, 'pendingMarketingRequests': null, 'pendingSupportTickets': null,
        },
        'unavailable': ['riderPaymentsDue', 'pendingMarketingRequests', 'pendingSupportTickets'],
      });
}

Future<void> _pump(WidgetTester t, Widget child, {Brightness b = Brightness.light, Size size = const Size(390, 860)}) async {
  t.view.physicalSize = size * 2;
  t.view.devicePixelRatio = 2;
  addTearDown(t.view.reset);
  // A test harness outside test/, so the analyzer does not know it is one.
  // ignore: invalid_use_of_visible_for_testing_member
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  await t.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      managerMeProvider.overrideWith(_FixedMe.new),
      dashboardProvider.overrideWith(_FixedDashboard.new),
      statsProvider.overrideWith((_) async => StatsData.fromJson(statsJson())),
    ],
    child: MaterialApp(debugShowCheckedModeBanner: false, theme: buildTheme(b), home: child),
  ));
  await t.pumpAndSettle();
}

Future<void> _shot(WidgetTester t, String name) =>
    expectLater(find.byType(MaterialApp).first, matchesGoldenFile('out/$name.png'));

void main() {
  setUpAll(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await _fonts();
  });

  for (final b in Brightness.values) {
    testWidgets('home dashboard ($b)', (t) async {
      await _pump(t, const HomeScreen(), b: b, size: const Size(390, 1500));
      await _shot(t, 'home-${b.name}');
    });
  }

  testWidgets('home dashboard, tablet', (t) async {
    await _pump(t, const HomeScreen(), size: const Size(1024, 900));
    await _shot(t, 'home-tablet');
  });

  testWidgets('statistics', (t) async {
    await _pump(t, const StatsScreen(), size: const Size(390, 3400));
    await _shot(t, 'stats-light');
  });
}
