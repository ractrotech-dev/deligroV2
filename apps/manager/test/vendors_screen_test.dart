import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/vendors/vendors_screen.dart';
import 'package:deligro_manager/models/vendors.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_vendor_product_repositories.dart';
import 'fixtures/fixtures.dart';
import 'vp_helpers.dart';

VendorPage _page(String tag, {String? next}) {
  final j = apiFixture('vendors_list');
  final items = [
    for (final m in (j['items'] as List).cast<Map<String, dynamic>>()) {...m, 'id': '${m['id']}-$tag', 'name': '${m['name']} $tag'},
  ];
  return VendorPage.fromJson({...j, 'items': items, 'nextCursor': next});
}

void main() {
  testWidgets('the first page renders and is asked for without a cursor', (tester) async {
    final fake = FakeVendorsRepository();
    await pumpVp(tester, const VendorsScreen(), vendors: fake);
    expect(fake.listCalls.first.cursor, isNull);
    expect(find.text('Spice Hub'), findsOneWidget);
    expect(find.text('Open now'), findsWidgets);
    expect(find.text('Pending (3)'), findsOneWidget);
    expect(find.text('Suspended (2)'), findsOneWidget);
  });

  testWidgets('scrolling loads the next cursor and stops at the last page', (tester) async {
    final fake = FakeVendorsRepository();
    fake.pages[null] = VendorPage(
      items: [for (var i = 0; i < 6; i++) ..._page('a$i').items],
      nextCursor: 'c2',
      counts: _page('x').counts,
    );
    fake.pages['c2'] = _page('b');
    await pumpVp(tester, const VendorsScreen(), vendors: fake);
    for (var i = 0; i < 6; i++) {
      await tester.drag(find.byKey(const Key('vendors-list')), const Offset(0, -3000));
      await tester.pump();
      await tester.pump();
    }
    expect(fake.listCalls.map((c) => c.cursor), containsAllInOrder([null, 'c2']));
    expect(fake.listCalls.where((c) => c.cursor == 'c2'), hasLength(1));
  });

  testWidgets('a status tab asks for that status', (tester) async {
    final fake = FakeVendorsRepository();
    await pumpVp(tester, const VendorsScreen(), vendors: fake);
    await tester.tap(find.text('Pending (3)'));
    await tester.pump();
    await tester.pump();
    expect(fake.listCalls.last.filters.toQuery()['status'], 'pending');
  });

  testWidgets('the dashboard link opens with "Open now" on', (tester) async {
    final fake = FakeVendorsRepository();
    await pumpVp(tester, VendorsScreen(query: Uri.parse('/more/vendors?filter=online')), vendors: fake);
    expect(fake.listCalls.first.filters.filter, VendorQuickFilter.online);
    final chip = tester.widget<FilterChip>(find.byKey(const Key('vendor-chip-online')));
    expect(chip.selected, isTrue);
  });

  testWidgets('search asks once, after the debounce', (tester) async {
    final fake = FakeVendorsRepository();
    await pumpVp(tester, const VendorsScreen(), vendors: fake);
    final before = fake.listCalls.length;
    await tester.enterText(find.byKey(const Key('vendors-search')), 'sp');
    await tester.pump(const Duration(milliseconds: 100));
    await tester.enterText(find.byKey(const Key('vendors-search')), 'spi');
    await tester.pump(const Duration(milliseconds: 450));
    await tester.pump();
    final after = fake.listCalls.sublist(before);
    expect(after, hasLength(1));
    expect(after.single.filters.q, 'spi');
  });

  testWidgets('an empty filtered result shows one quiet line', (tester) async {
    final fake = FakeVendorsRepository()..page = const VendorPage(items: []);
    await pumpVp(tester, VendorsScreen(query: Uri.parse('/more/vendors?q=zzz')), vendors: fake);
    expect(find.text('No vendors match these filters.'), findsOneWidget);
  });

  testWidgets('an error offers Retry, which asks again', (tester) async {
    final fake = FakeVendorsRepository()..listError = ApiException(0, 'network');
    await pumpVp(tester, const VendorsScreen(), vendors: fake);
    expect(find.text('Retry'), findsOneWidget);
    await tester.tap(find.text('Retry'));
    await tester.pump();
    await tester.pump();
    expect(find.text('Spice Hub'), findsOneWidget);
    expect(fake.listCalls, hasLength(2));
  });

  testWidgets('Add vendor shows only with the onboarding permission', (tester) async {
    await pumpVp(tester, const VendorsScreen());
    expect(find.byKey(const Key('vendors-add')), findsNothing);
  });

  testWidgets('Add vendor is offered to a manager who may onboard', (tester) async {
    await pumpVp(tester, const VendorsScreen(), permissions: {...vendorViewer, 'manager.vendors.onboard'});
    expect(find.byKey(const Key('vendors-add')), findsOneWidget);
  });

  testWidgets('tapping a vendor opens it', (tester) async {
    String? opened;
    await pumpVp(tester, VendorsScreen(onOpen: (_, v) => opened = v.id));
    await tester.tap(find.text('Raja Sweets'));
    expect(opened, 'v-3');
  });

  testWidgets('a tablet shows the list and the chosen vendor side by side', (tester) async {
    await pumpVp(tester, const VendorsScreen(), size: const Size(1200, 900));
    expect(find.text('Pick a vendor to see it here.'), findsOneWidget);
    await tester.tap(find.text('Spice Hub'));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('vendor-detail-body')), findsOneWidget);
  });
}
