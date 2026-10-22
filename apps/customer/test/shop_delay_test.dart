// Ruling P7-R1: a rider's shop-delay report reaches the customer as one fixed
// sentence, "The shop is running late" — never the report's own words.

import 'package:deligro_customer/features/orders/tracking_screen.dart';
import 'package:deligro_customer/models/tracking.dart';
import 'package:deligro_customer/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

Map<String, dynamic> _snap([Object? flag]) => {
      'status': 'READY',
      'eta': {'minutesRemaining': 12, 'late': false, 'lateByMinutes': 0},
      'rider': null,
      'restaurant': null,
      'destination': null,
      'riderPositionSource': 'none',
      'shopRunningLate': ?flag,
    };

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  test('the snapshot reads shopRunningLate; absent or anything but true is false', () {
    expect(TrackingSnapshot.fromJson(_snap(true)).shopRunningLate, isTrue);
    expect(TrackingSnapshot.fromJson(_snap(false)).shopRunningLate, isFalse);
    expect(TrackingSnapshot.fromJson(_snap()).shopRunningLate, isFalse, reason: 'an older server');
    expect(TrackingSnapshot.fromJson(_snap('yes')).shopRunningLate, isFalse);
  });

  test('the wording is fixed and matches the website', () {
    expect(kShopRunningLate, 'The shop is running late');
  });

  for (final b in Brightness.values) {
    testWidgets('the notice shows exactly the fixed sentence (${b.name})', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: buildTheme(b),
        home: const Scaffold(body: Center(child: ShopDelayNotice())),
      ));
      expect(find.text('The shop is running late'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }
}
