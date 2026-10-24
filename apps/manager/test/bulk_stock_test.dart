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
}
