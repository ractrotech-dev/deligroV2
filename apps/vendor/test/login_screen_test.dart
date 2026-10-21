import 'package:deligro_partner/features/auth/login_screen.dart';
import 'package:deligro_partner/state/prefs.dart';
import 'package:deligro_partner/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

Future<void> _pump(WidgetTester t, {Brightness b = Brightness.light, double scale = 1}) async {
  t.view.physicalSize = const Size(1080, 2340);
  t.view.devicePixelRatio = 3; // a 360×780 phone
  addTearDown(t.view.reset);
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  await t.pumpWidget(
    ProviderScope(
      overrides: [prefsProvider.overrideWithValue(prefs)],
      child: MaterialApp(
        theme: buildTheme(b),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: const LoginScreen(),
      ),
    ),
  );
  await t.pump();
}

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  for (final (b, scale, name) in [
    (Brightness.light, 1.0, 'light'),
    (Brightness.dark, 1.0, 'dark'),
    (Brightness.light, 1.3, 'large text'),
  ]) {
    testWidgets('both sign-in methods render ($name)', (t) async {
      await _pump(t, b: b, scale: scale);
      expect(find.text('Get OTP'), findsOneWidget);
      expect(t.takeException(), isNull);
      await t.tap(find.text('Password'));
      await t.pumpAndSettle();
      expect(find.text('Mobile number or email'), findsOneWidget);
      expect(t.takeException(), isNull);
    });
  }
}
