import 'package:deligro_manager/features/products/products_screen.dart';
import 'package:deligro_manager/features/products/restricted_categories_screen.dart';
import 'package:deligro_manager/models/products.dart';
import 'package:deligro_manager/models/vendors.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_vendor_product_repositories.dart';
import 'vp_helpers.dart';

const _moderator = {'manager.products.view', 'manager.products.moderate', 'manager.vendors.view'};

void main() {
  group('request bodies', () {
    test('a flag carries its description as note, never as reason', () {
      final withNote = FlagListing(flagReason: FlagReason.pickable.first, note: ' Photo shows a burger ').toJson();
      expect(withNote['note'], 'Photo shows a burger');
      expect(withNote.containsKey('reason'), isFalse);
      expect(withNote['flagReason'], FlagReason.pickable.first.wire);
      final bare = FlagListing(flagReason: FlagReason.pickable.first).toJson();
      expect(bare.containsKey('note'), isFalse);
      expect(bare.containsKey('reason'), isFalse);
    });

    test('verifying a document takes an optional note', () {
      final bare = VerifyDocument(documentId: 'd1').toJson();
      expect(bare, containsPair('action', 'verify_document'));
      expect(bare.containsKey('note'), isFalse);
      expect(bare.containsKey('reason'), isFalse);
      expect(VerifyDocument(documentId: 'd1', note: 'Checked the original').toJson()['note'], 'Checked the original');
      // Rejecting still needs a reason.
      expect(RejectDocument(documentId: 'd1', reason: 'Blurry scan').toJson()['reason'], 'Blurry scan');
    });
  });

  testWidgets('product filters offer every shop in the directory, not only loaded ones', (tester) async {
    final vendors = FakeVendorsRepository();
    await pumpVp(tester, const ProductsScreen(), vendors: vendors, permissions: _moderator);
    await tester.pumpAndSettle();
    expect(vendors.directoryCalls, isNotEmpty);
    await tester.tap(find.byKey(const Key('products-filters')));
    await tester.pumpAndSettle();
    expect(find.text('Zaika Corner'), findsOneWidget);
    expect(find.text('Starters'), findsWidgets);
  });

  testWidgets('restricted categories suggest the categories vendors use', (tester) async {
    final fake = FakeProductsRepository();
    await pumpVp(tester, const RestrictedCategoriesScreen(), products: fake, permissions: _moderator, role: 'admin');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('restricted-add')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('restricted-name')), 'sta');
    await tester.pumpAndSettle();
    // Starters is used and not yet restricted; Beverages already is.
    expect(find.byKey(const Key('restricted-suggestion-Starters')), findsOneWidget);
    expect(find.byKey(const Key('restricted-suggestion-Beverages')), findsNothing);
    await tester.tap(find.byKey(const Key('restricted-suggestion-Starters')));
    await tester.enterText(find.byKey(const Key('reason-field')), 'Needs a licence check');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await tester.pumpAndSettle();
    expect(fake.restrictCalls.single.name, 'Starters');
  });
}
