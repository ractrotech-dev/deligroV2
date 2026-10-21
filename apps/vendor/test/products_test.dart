import 'package:deligro_partner/data/menu_repository.dart';
import 'package:deligro_partner/features/products/product_editor_screen.dart';
import 'package:deligro_partner/features/products/products_screen.dart';
import 'package:deligro_partner/models/menu.dart';
import 'package:deligro_partner/state/menu.dart';
import 'package:deligro_partner/state/session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

class MockMenuRepo extends Mock implements MenuRepository {}

const _ids = ['11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000003'];

Map<String, dynamic> itemJson(
  String id,
  String name, {
  int price = 180,
  String category = 'Starters',
  bool veg = true,
  bool available = true,
  int sold = 0,
  int? stock,
  int? lowAt,
  List<Map<String, dynamic>> variants = const [],
}) =>
    {
      'id': id,
      'name': name,
      'description': '',
      'price': price,
      'category': category,
      'veg': veg,
      'available': available,
      'popular': false,
      'bestseller': false,
      'imageUrl': null,
      'sortOrder': 0,
      'soldCount': sold,
      'soldRevenue': sold * price,
      'stockQty': stock,
      'lowStockAt': lowAt,
      'soldOutByStock': false,
      'availableDays': null,
      'availableFrom': null,
      'availableTo': null,
      'variants': variants,
      'addonGroups': [],
    };

Map<String, dynamic> menuJson({bool canEdit = true, bool inventory = true}) => {
      'restaurantId': 's1',
      'categories': ['Starters', 'Main course'],
      'items': [
        itemJson(_ids[0], 'Paneer Tikka', sold: 42, stock: 3, lowAt: 5),
        itemJson(_ids[1], 'Chicken Biryani', price: 260, category: 'Main course', veg: false, sold: 80, variants: [
          {'id': 'v1', 'name': 'Half', 'price': 160, 'available': true},
          {'id': 'v2', 'name': 'Full', 'price': 260, 'available': true},
        ]),
        itemJson(_ids[2], 'Dal Makhani', price: 210, category: 'Main course', available: false, sold: 12),
      ],
      'inventorySupported': inventory,
      'canEdit': canEdit,
    };

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
    registerFallbackValue(<String, Object?>{});
    registerFallbackValue(<MenuOption>[]);
    registerFallbackValue(<AddonGroup>[]);
  });

  late MockMenuRepo repo;
  setUp(() => repo = MockMenuRepo());

  Future<void> open(WidgetTester t, Widget screen, {Map<String, dynamic>? json, String? lang}) async {
    when(repo.load).thenAnswer((_) async => Menu.fromJson(json ?? menuJson()));
    await pumpPartner(
      t,
      child: screen,
      overrides: [
        menuRepoProvider.overrideWithValue(repo),
        vendorMeProvider.overrideWith(() => FixedMe(fakeMe())),
      ],
      lang: lang,
    );
    await t.pumpAndSettle();
  }

  test('stock, sizes and schedule from the menu answer', () {
    final m = Menu.fromJson(menuJson());
    final tikka = m.items[0], biryani = m.items[1];
    expect(tikka.lowStock, isTrue);
    expect(tikka.outOfStock, isFalse);
    expect(biryani.fromPrice, 160);
    expect(biryani.hasOptions, isTrue);
    expect(m.lowStockCount, 1);
    expect(MenuItem.fromJson(itemJson('x', 'X', stock: 0, lowAt: 5)).lowStock, isFalse,
        reason: 'out of stock is its own state, not "low"');
  });

  testPartner('lists items by category with stock and sales', (t) async {
    await open(t, const ProductsScreen());
    expect(find.text('STARTERS · 1'), findsOneWidget);
    expect(find.text('Low · 3 left'), findsOneWidget);
    expect(find.text('from ₹160 · 80 sold'), findsOneWidget);
  });

  testPartner('the low-stock filter shows only items running out', (t) async {
    await open(t, const ProductsScreen(filter: 'low_stock'));
    expect(find.text('Paneer Tikka'), findsOneWidget);
    expect(find.text('Chicken Biryani'), findsNothing);
  });

  testPartner('the switch marks an item sold out', (t) async {
    when(() => repo.update(any(), any())).thenAnswer((_) async {});
    await open(t, const ProductsScreen());
    await t.tap(find.byType(Switch).first);
    await t.pumpAndSettle();
    verify(() => repo.update(_ids[0], {'available': false})).called(1);
  });

  testPartner('read-only menu: no add button, no switches', (t) async {
    await open(t, const ProductsScreen(), json: menuJson(canEdit: false));
    expect(find.text('Add item'), findsNothing);
    expect(t.widget<Switch>(find.byType(Switch).first).onChanged, isNull);
  });

  testPartner('adding an item sends its details', (t) async {
    when(() => repo.create(any())).thenAnswer((_) async => 'new-id');
    await open(t, const ProductEditorScreen());
    await t.enterText(find.widgetWithText(TextFormField, 'Item name'), 'Masala Dosa');
    await t.enterText(find.widgetWithText(TextFormField, 'Price (₹)'), '120');
    await t.tap(find.text('Add item').last);
    await t.pumpAndSettle();
    final sent = verify(() => repo.create(captureAny())).captured.single as Map<String, Object?>;
    expect(sent['name'], 'Masala Dosa');
    expect(sent['price'], 120);
    expect(sent['category'], 'Starters');
    expect(sent['veg'], true);
    expect(sent['stockQty'], isNull);
    verifyNever(() => repo.setOptions(any(), any(), any()));
  });

  testPartner('editing sends only what changed', (t) async {
    when(() => repo.update(any(), any())).thenAnswer((_) async {});
    await open(t, const ProductEditorScreen(itemId: '11111111-0000-0000-0000-000000000003'));
    expect(find.text('12'), findsOneWidget, reason: 'units sold');
    await t.enterText(find.widgetWithText(TextFormField, 'Price (₹)'), '230');
    await t.ensureVisible(find.text('Save changes'));
    await t.tap(find.text('Save changes'));
    await t.pumpAndSettle();
    verify(() => repo.update(_ids[2], {'price': 230})).called(1);
  });

  testPartner('a new size is saved with the item', (t) async {
    when(() => repo.update(any(), any())).thenAnswer((_) async {});
    when(() => repo.setOptions(any(), any(), any())).thenAnswer((_) async {});
    await open(t, const ProductEditorScreen(itemId: '11111111-0000-0000-0000-000000000002'));
    await t.scrollUntilVisible(find.text('Add size'), 300, scrollable: find.byType(Scrollable).first);
    await t.tap(find.text('Add size'));
    await t.pumpAndSettle();
    await t.enterText(find.widgetWithText(TextFormField, 'Name'), 'Family pack');
    await t.enterText(find.widgetWithText(TextFormField, 'Price of this size (₹)'), '480');
    await t.tap(find.text('Done'));
    await t.pumpAndSettle();
    await t.tap(find.text('Save changes'));
    await t.pumpAndSettle();
    final captured = verify(() => repo.setOptions(_ids[1], captureAny(), captureAny())).captured;
    final variants = captured[0] as List<MenuOption>;
    expect(variants.map((v) => v.name), ['Half', 'Full', 'Family pack']);
    expect(variants.first.id, 'v1', reason: 'kept sizes keep their ids');
    verifyNever(() => repo.update(any(), any()));
  });

  testPartner('without 0062 the stock and options sections hide', (t) async {
    await open(t, const ProductEditorScreen(itemId: '11111111-0000-0000-0000-000000000001'), json: menuJson(inventory: false));
    expect(find.text('Count stock'), findsNothing);
    expect(find.text('Add size'), findsNothing);
  });

  testPartner('reads in Hindi', (t) async {
    await open(t, const ProductsScreen(), lang: 'hi');
    expect(find.text('प्रोडक्ट और स्टॉक'), findsOneWidget);
    expect(t.takeException(), isNull);
  });
}
