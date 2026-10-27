import 'package:deligro_manager/features/products/bulk_stock_screen.dart';
import 'package:deligro_manager/features/products/products_screen.dart';
import 'package:deligro_manager/models/bulk.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'vp_helpers.dart';

Map<String, dynamic> _preview() => {
  'mode': 'preview',
  'counts': {'create': 0, 'update': 2, 'unchanged': 1, 'error': 1},
  'items': [
    {'line': 2, 'action': 'update', 'name': 'Paneer Tikka', 'changes': ['stock 10 → 25']},
    {'line': 5, 'action': 'error', 'name': 'Dal', 'changes': [], 'message': 'No dish matches this row, and new dishes can\'t be added here.'},
  ],
  'moreItems': 0,
  'issues': [],
  'columns': ['id', 'stock'],
  'unknownColumns': [],
  'ignoredColumns': ['price', 'available'],
};

void main() {
  test('a stock preview is read, including the columns a manager may not set', () {
    final o = BulkOutcome.fromJson(_preview());
    expect((o.create, o.update, o.unchanged, o.error), (0, 2, 1, 1));
    expect(o.toApply, 2);
    expect(o.ignoredColumns, ['price', 'available']);
    expect(o.items.first.changes, ['stock 10 → 25']);
    expect(o.items.last.message, contains('new dishes'));
  });

  testWidgets('the screen starts with a shop to choose and nothing to send', (tester) async {
    await pumpVp(tester, const BulkStockScreen(), permissions: const {'manager.products.view', 'manager.products.adjust_stock'});
    await tester.pumpAndSettle();
    expect(find.text('Bulk stock update'), findsOneWidget);
    expect(find.byKey(const Key('bulk-vendor')), findsOneWidget);
    final choose = tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Choose a file'));
    expect(choose.onPressed, isNull, reason: 'a shop must be chosen first');
    expect(find.textContaining('Apply'), findsNothing);
  });

  testWidgets('a manager without the stock permission is not offered the bulk update', (tester) async {
    await pumpVp(tester, const ProductsScreen(), permissions: productViewer);
    await tester.tap(find.byKey(const Key('products-menu')));
    await tester.pumpAndSettle();
    expect(find.text('Insights'), findsOneWidget);
    expect(find.text('Bulk stock update'), findsNothing);
  });

  testWidgets('a manager who may adjust stock is offered it', (tester) async {
    await pumpVp(tester, const ProductsScreen(), permissions: const {...productViewer, 'manager.products.adjust_stock'});
    await tester.tap(find.byKey(const Key('products-menu')));
    await tester.pumpAndSettle();
    expect(find.text('Bulk stock update'), findsOneWidget);
  });

  testWidgets('menu mode shows "Menu sheet", the template button and the go-live note', (tester) async {
    await pumpVp(tester, const BulkStockScreen(mode: BulkSheetMode.menu),
        permissions: const {'manager.products.view', 'manager.products.bulk_menu'});
    await tester.pumpAndSettle();
    expect(find.text('Menu sheet'), findsOneWidget);
    expect(find.byKey(const Key('bulk-template')), findsOneWidget);
    expect(find.textContaining('go live at once'), findsOneWidget);
    expect(find.textContaining('restricted'), findsOneWidget);
  });

  testWidgets('menu mode Apply is disabled without manager.products.bulk_menu', (tester) async {
    await pumpVp(tester, const BulkStockScreen(mode: BulkSheetMode.menu, debugOutcome: _menuPreview),
        permissions: const {'manager.products.view'});
    await tester.pumpAndSettle();
    final apply = tester.widget<FilledButton>(find.byKey(const Key('bulk-apply')));
    expect(apply.onPressed, isNull);
    expect(find.textContaining('menu sheet permission'), findsOneWidget);
  });

  testWidgets('menu mode preview shows "3 new, 2 changed"', (tester) async {
    await pumpVp(tester, const BulkStockScreen(mode: BulkSheetMode.menu, debugOutcome: _menuPreview),
        permissions: const {'manager.products.view', 'manager.products.bulk_menu'});
    await tester.pumpAndSettle();
    expect(find.text('3 new'), findsOneWidget);
    expect(find.text('2 to change'), findsOneWidget);
    expect(find.text('Apply 5 changes'), findsOneWidget);
  });
}

const _menuPreview = {
  'mode': 'preview',
  'counts': {'create': 3, 'update': 2, 'unchanged': 0, 'error': 0},
  'items': <Map<String, dynamic>>[],
  'moreItems': 0,
  'issues': <Map<String, dynamic>>[],
  'columns': ['name', 'price'],
  'unknownColumns': <String>[],
  'ignoredColumns': <String>[],
};
