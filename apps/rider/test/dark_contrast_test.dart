// Text on the solid red (`deal`) and green fills must stay readable in the
// dark theme, where those fills are bright: dark ink, not white.
import 'dart:math' as math;

import 'package:deligro_rider/features/safety/sos_sheet.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

double _lum(Color c) {
  double ch(double v) => v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

double contrast(Color a, Color b) {
  final x = _lum(a), y = _lum(b);
  return (math.max(x, y) + 0.05) / (math.min(x, y) + 0.05);
}

void main() {
  for (final (name, c) in [('light', AppColors.light), ('dark', AppColors.dark)]) {
    test('$name: ink on the red and green fills is at least 4.5:1', () {
      expect(contrast(c.onDeal, c.deal), greaterThanOrEqualTo(4.5));
      expect(contrast(c.onGreen, c.green), greaterThanOrEqualTo(4.5));
    });
  }

  testWidgets('the SOS button uses the dark ink in the dark theme', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildTheme(Brightness.dark),
      home: const Scaffold(body: Center(child: SosButton())),
    ));
    final style = tester.widget<FilledButton>(find.byKey(const Key('sos-button'))).style!;
    expect(style.foregroundColor!.resolve({}), AppColors.dark.onDeal);
    expect(style.backgroundColor!.resolve({}), AppColors.dark.deal);
  });
}
