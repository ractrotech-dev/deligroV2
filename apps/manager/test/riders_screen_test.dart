import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/riders/riders_screen.dart';
import 'package:deligro_manager/models/rider.dart';
import 'package:deligro_manager/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_rider_repositories.dart';
import 'rider_helpers.dart';

void main() {
  testWidgets('first page is asked for with no cursor and the rows show', (tester) async {
    final fakes = RiderFakes();
    await pumpRider(tester, const RidersScreen(), fakes: fakes);
    expect(fakes.riders.listCalls.first.cursor, isNull);
    expect(find.text('Ravi Kumar'), findsOneWidget);
    expect(find.text('DR-0007'), findsOneWidget);
    expect(find.text('On delivery'), findsWidgets);
  });

  testWidgets('scrolling loads the next page and stops when there is none', (tester) async {
    final fakes = RiderFakes();
    final base = fakes.riders.page;
    final many = [
      for (var i = 0; i < 20; i++)
        RiderListItem.fromJson({
          'id': 'r-x$i',
          'name': 'Rider $i',
          'state': 'available',
          'verification': 'verified',
          'account': 'active',
        }),
    ];
    fakes.riders.page = RiderPage(items: many, nextCursor: 'c-2', counts: base.counts);
    fakes.riders.pages['c-2'] = RiderPage(items: base.items, counts: base.counts);
    await pumpRider(tester, const RidersScreen(), fakes: fakes, size: const Size(400, 700));
    await tester.drag(find.byKey(const Key('riders-list')), const Offset(0, -3000));
    await tester.pumpAndSettle();
    expect(fakes.riders.listCalls.map((c) => c.cursor), contains('c-2'));
    final before = fakes.riders.listCalls.length;
    await tester.drag(find.byKey(const Key('riders-list')), const Offset(0, -3000));
    await tester.pumpAndSettle();
    expect(fakes.riders.listCalls.where((c) => c.cursor != null).length, 1);
    expect(fakes.riders.listCalls.length, before);
  });

  testWidgets('"Available (5)" asks for available riders', (tester) async {
    final fakes = RiderFakes();
    await pumpRider(tester, const RidersScreen(), fakes: fakes);
    await tester.tap(find.text('Available (5)'));
    await tester.pump();
    await tester.pump();
    expect(fakes.riders.listCalls.last.filters.states, {RiderState.available});
    expect(fakes.riders.listCalls.last.filters.toQuery()['state'], 'available');
  });

  testWidgets('the route ?state=on_delivery opens that tab', (tester) async {
    final fakes = RiderFakes();
    await pumpRider(tester, RidersScreen(query: Uri.parse('/more/riders?state=on_delivery')), fakes: fakes);
    expect(fakes.riders.listCalls.first.filters.states, {RiderState.onDelivery});
    final chip = tester.widget<ChoiceChip>(find.byKey(const Key('rider-tab-on_delivery')));
    expect(chip.selected, isTrue);
  });

  testWidgets('typing "DR-00" asks once, after the pause', (tester) async {
    final fakes = RiderFakes();
    await pumpRider(tester, const RidersScreen(), fakes: fakes);
    await tester.enterText(find.byKey(const Key('riders-search')), 'DR');
    await tester.pump(const Duration(milliseconds: 100));
    await tester.enterText(find.byKey(const Key('riders-search')), 'DR-00');
    await tester.pump(const Duration(milliseconds: 450));
    await tester.pump();
    final searched = fakes.riders.listCalls.where((c) => c.filters.q != null).toList();
    expect(searched, hasLength(1));
    expect(searched.single.filters.q, 'DR-00');
  });

  testWidgets('a stale fix reads "updated 6 min ago" in grey', (tester) async {
    await pumpRider(tester, const RidersScreen());
    final t = tester.widget<Text>(find.text('updated 6 min ago'));
    final ctx = tester.element(find.text('updated 6 min ago'));
    expect(t.style?.color, ctx.colors.muted);
    // A fresh fix (42 s) is not grey.
    final fresh = tester.widget<Text>(find.text('updated just now'));
    expect(fresh.style?.color, isNot(ctx.colors.muted));
  });

  testWidgets('a filtered list that came back empty gets the dashed line', (tester) async {
    final fakes = RiderFakes();
    await pumpRider(tester, RidersScreen(query: Uri.parse('/more/riders?state=break')), fakes: fakes);
    fakes.riders.page = const RiderPage(items: []);
    await tester.ensureVisible(find.byKey(const Key('rider-chip-suspended')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('rider-chip-suspended')));
    await tester.pump();
    await tester.pump();
    expect(find.text('No riders match these filters.'), findsOneWidget);
  });

  testWidgets('an error offers Retry, which asks again', (tester) async {
    final fakes = RiderFakes();
    fakes.riders.listError = ApiException(500, 'boom');
    await pumpRider(tester, const RidersScreen(), fakes: fakes);
    expect(find.text('Retry'), findsOneWidget);
    fakes.riders.listError = null;
    await tester.tap(find.text('Retry'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Ravi Kumar'), findsOneWidget);
  });

  testWidgets('no "Add rider" without manager.riders.onboard', (tester) async {
    await pumpRider(tester, const RidersScreen());
    expect(find.byKey(const Key('riders-add')), findsNothing);
  });

  testWidgets('"Add rider" with manager.riders.onboard', (tester) async {
    await pumpRider(tester, const RidersScreen(), permissions: {...riderViewer, 'manager.riders.onboard'});
    expect(find.byKey(const Key('riders-add')), findsOneWidget);
  });

  testWidgets('a rider with no name reads as unnamed; badges for documents and complaints', (tester) async {
    await pumpRider(tester, const RidersScreen());
    expect(find.text('Unnamed rider'), findsOneWidget);
    expect(find.text('2 documents to review'), findsOneWidget);
    expect(find.text('1 open complaint'), findsOneWidget);
    expect(find.text('1 expiring'), findsOneWidget);
  });

  test('fixtures used here exist', () {
    expect(p5('riders_list')['items'], isNotEmpty);
  });
}
