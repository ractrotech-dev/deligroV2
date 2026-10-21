import 'package:deligro_partner/features/reports/analytics_view.dart';
import 'package:deligro_partner/models/analytics.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'support/fakes.dart';

Map<String, dynamic> analyticsJson({String unit = 'day', bool previous = true}) => {
      'window': {'unit': unit, 'from': '2026-10-15', 'to': '2026-10-21'},
      'buckets': [
        for (var i = 0; i < 7; i++)
          {'start': '2026-10-${15 + i}', 'sales': [8000, 12000, 9000, 15000, 22000, 31000, 27560][i], 'orders': 10 + i, 'prevSales': previous ? 9000 + i * 1000 : 0},
      ],
      'totals': {
        'sales': 124560,
        'orders': 142,
        'averageOrderValue': 877,
        'salesChange': previous ? 18.0 : null,
        'ordersChange': previous ? 12.0 : null,
        'averageOrderValueChange': previous ? 8.0 : null,
      },
      'bestDays': [
        {'day': '2026-10-20', 'sales': 31000, 'orders': 15},
      ],
      'hours': [for (var h = 0; h < 24; h++) {'hour': h, 'sales': h == 19 ? 30000 : h * 100, 'orders': 1}],
      'peak': {'fromHour': 18, 'toHour': 20, 'sales': 31800},
      'bestSellers': [
        {'menuItemId': 'm1', 'name': 'Paneer Tikka', 'qty': 84, 'revenue': 15120},
      ],
      'slowMovers': [
        {'menuItemId': 'm9', 'name': 'Kulfi', 'qty': 0, 'revenue': 0},
      ],
    };

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  final asked = <AnalyticsQuery>[];
  Future<void> open(WidgetTester t, {bool previous = true, Brightness b = Brightness.light, double scale = 1}) async {
    asked.clear();
    await pumpPartner(
      t,
      child: const Scaffold(body: AnalyticsView()),
      overrides: [
        analyticsProvider.overrideWith((ref, q) async {
          asked.add(q);
          return Analytics.fromJson(analyticsJson(unit: q.granularity == 'week' ? 'week' : 'day', previous: previous));
        }),
      ],
      b: b,
      scale: scale,
    );
    await t.pumpAndSettle();
  }

  testPartner('shows totals, comparison, best days, peak hours and dishes', (t) async {
    await open(t);
    expect(find.text('₹1,24,560'), findsOneWidget);
    expect(find.text('↑ 18%'), findsOneWidget);
    expect(find.text('142'), findsOneWidget);
    expect(find.text('₹877'), findsOneWidget);
    await t.scrollUntilVisible(find.text('Best performing days'), 150, scrollable: find.byType(Scrollable).first);
    expect(find.text('6 PM – 8 PM'), findsOneWidget);
    await t.scrollUntilVisible(find.text('Kulfi'), 150, scrollable: find.byType(Scrollable).first);
    expect(find.text('Paneer Tikka'), findsOneWidget);
    expect(find.text('84 sold'), findsOneWidget);
    expect(find.text('not sold'), findsOneWidget);
  });

  testPartner('a granularity chip asks for that period', (t) async {
    await open(t);
    await t.tap(find.text('Week'));
    await t.pumpAndSettle();
    expect(asked.last.granularity, 'week');
  });

  testPartner('no previous sales shows no % change', (t) async {
    await open(t, previous: false);
    expect(find.textContaining('%'), findsNothing);
  });

  for (final (b, scale, name) in [
    (Brightness.light, 1.0, 'light'),
    (Brightness.dark, 1.0, 'dark'),
    (Brightness.light, 1.3, 'large text'),
  ]) {
    testPartner('renders without overflow ($name)', (t) async {
      await open(t, b: b, scale: scale);
      expect(t.takeException(), isNull);
      await t.drag(find.byType(ListView).first, const Offset(0, -1400));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
    });
  }
}
