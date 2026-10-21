import 'package:deligro_partner/models/dashboard.dart';
import 'package:deligro_partner/router.dart';
import 'package:deligro_partner/state/dashboard.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

Map<String, dynamic> dashboardJson({bool money = true, int paymentDue = 8650}) => {
  'sales': {'today': 12450, 'yesterday': 11116, 'total': 324780, 'thisMonth': 62000, 'lastMonth': 52542},
  'live': {'new': 5, 'accepted': 8, 'preparing': 3, 'ready': 2},
  'today': {'orders': 21, 'completed': 48, 'cancelled': 2},
  'money': money
      ? {'totalEarnings': 248600, 'paidOrders': 482, 'unpaidOrders': 6, 'partlyPaidOrders': 1, 'paymentDue': paymentDue}
      : null,
  'marketing': {'available': true, 'pending': 2, 'approved': 1, 'inProgress': 0, 'completed': 0, 'rejected': 0},
};

class FixedDashboard extends DashboardNotifier {
  FixedDashboard(this.d);
  final Dashboard d;
  @override
  Future<Dashboard> build() async => d;
}

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  late MockOrdersRepo repo;
  setUp(() {
    repo = MockOrdersRepo();
    when(repo.board).thenAnswer((_) async => fakeBoard());
  });

  Future<void> open(
    WidgetTester t,
    Map<String, dynamic> json, {
    Brightness b = Brightness.light,
    double scale = 1,
  }) async {
    await pumpPartner(
      t,
      router: (ref) => ref.watch(routerProvider),
      overrides: [
        ...ordersOverrides(repo),
        dashboardProvider.overrideWith(() => FixedDashboard(Dashboard.fromJson(json))),
      ],
      b: b,
      scale: scale,
    );
    await t.pumpAndSettle();
  }

  test('changes are % against the earlier figure, none against zero', () {
    final d = Dashboard.fromJson(dashboardJson());
    expect(d.todayChange, 12);
    expect(d.monthChange, 18);
    expect(Dashboard.change(5, 0), isNull);
  });

  testPartner('shows all 13 figures', (t) async {
    await open(t, dashboardJson());
    for (final text in [
      '₹12,450', '₹3,24,780', // today's and total sale
      'New orders', 'Accepted', 'Preparing', 'Ready for pickup', 'Completed today', 'Cancelled today',
      'Payment due to you', '₹8,650', 'Paid orders', '482', '1 partly paid', 'Unpaid orders',
    ]) {
      await t.scrollUntilVisible(find.text(text), 120, scrollable: find.byType(Scrollable).first);
      expect(find.text(text), findsOneWidget, reason: text);
    }
    await t.scrollUntilVisible(find.text('Total vendor earnings'), 120, scrollable: find.byType(Scrollable).first);
    expect(find.text('₹2,48,600'), findsOneWidget);
    await t.scrollUntilVisible(find.text('Marketing requests'), 120, scrollable: find.byType(Scrollable).first);
    expect(find.text('2 pending · 1 approved'), findsOneWidget);
  });

  testPartner('a negative payment due says the shop owes Deligro', (t) async {
    await open(t, dashboardJson(paymentDue: -1200));
    await t.scrollUntilVisible(find.text('You owe Deligro'), 120, scrollable: find.byType(Scrollable).first);
    expect(find.text('₹1,200'), findsOneWidget);
  });

  testPartner('money tiles disappear when Earnings is switched off', (t) async {
    await open(t, dashboardJson(money: false));
    expect(find.text('Paid orders'), findsNothing);
    await t.scrollUntilVisible(
      find.textContaining('switched off for your shop'),
      120,
      scrollable: find.byType(Scrollable).first,
    );
  });

  testPartner('a stage tile opens Orders with that filter', (t) async {
    await open(t, dashboardJson());
    await t.tap(find.text('Preparing'));
    await t.pumpAndSettle();
    expect(find.text('Preparing (1)'), findsOneWidget);
    expect(find.text('#D-CC33'), findsOneWidget);
    expect(find.text('#D-AA11'), findsNothing);
  });

  for (final (b, scale, name) in [
    (Brightness.light, 1.0, 'light'),
    (Brightness.dark, 1.0, 'dark'),
    (Brightness.light, 1.3, 'large text'),
  ]) {
    testPartner('renders without overflow ($name)', (t) async {
      await open(t, dashboardJson(), b: b, scale: scale);
      expect(t.takeException(), isNull);
      await t.drag(find.byType(ListView).first, const Offset(0, -900));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
    });
  }
}
