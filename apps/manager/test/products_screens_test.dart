import 'dart:typed_data';

import 'package:deligro_manager/features/products/image_reviews_screen.dart';
import 'package:deligro_manager/features/products/product_detail_screen.dart';
import 'package:deligro_manager/features/products/replace_photo_sheet.dart';
import 'package:image_picker/image_picker.dart';
import 'package:deligro_manager/features/products/product_insights_screen.dart';
import 'package:deligro_manager/features/products/products_screen.dart';
import 'package:deligro_manager/features/products/restricted_categories_screen.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/products.dart';
import 'package:deligro_manager/state/products.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_vendor_product_repositories.dart';
import 'vp_helpers.dart';

const _moderator = {...productViewer, 'manager.products.moderate'};

Future<FakeProductsRepository> _detail(WidgetTester tester, {FakeProductsRepository? repo, Set<String> perms = _moderator}) async {
  final fake = repo ?? FakeProductsRepository();
  await pumpVp(tester, const ProductDetailScreen(productId: 'p-1'), products: fake, permissions: perms, size: const Size(400, 1400));
  await tester.pumpAndSettle();
  return fake;
}

Future<void> _act(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(Key(key)));
  await tester.pumpAndSettle();
}

void main() {
  group('list', () {
    testWidgets('a parked price change reads "old → new pending"', (tester) async {
      await pumpVp(tester, const ProductsScreen(), permissions: productViewer);
      expect(find.text('₹180 → ₹220 pending'), findsOneWidget);
      expect(find.text('Not tracked'), findsOneWidget);
      expect(find.text('Sold out'), findsOneWidget);
      expect(find.text('Hidden'), findsWidgets);
    });

    testWidgets('"Out of stock (4)" asks for out-of-stock products', (tester) async {
      final fake = FakeProductsRepository();
      await pumpVp(tester, const ProductsScreen(), products: fake, permissions: productViewer);
      await tester.ensureVisible(find.text('Out of stock (4)'));
      await tester.tap(find.text('Out of stock (4)'));
      await tester.pump();
      await tester.pump();
      expect(fake.listCalls.last.filters.toQuery(), {'availability': 'out_of_stock'});
    });

    testWidgets('Restricted categories is offered only to moderators', (tester) async {
      await pumpVp(tester, const ProductsScreen(), permissions: productViewer);
      await tester.tap(find.byKey(const Key('products-menu')));
      await tester.pumpAndSettle();
      expect(find.text('Categories'), findsOneWidget);
      expect(find.text('Insights'), findsOneWidget);
      expect(find.text('Restricted categories'), findsNothing);
    });

    testWidgets('a moderator sees Restricted categories in the menu', (tester) async {
      await pumpVp(tester, const ProductsScreen(), permissions: _moderator);
      await tester.tap(find.byKey(const Key('products-menu')));
      await tester.pumpAndSettle();
      expect(find.text('Restricted categories'), findsOneWidget);
    });
  });

  group('detail', () {
    testWidgets('history reads newest first, with who changed it', (tester) async {
      await _detail(tester);
      final stock = tester.getTopLeft(find.text('Stock Not tracked → 12')).dy;
      final price = tester.getTopLeft(find.text('Price ₹160 → ₹180')).dy;
      final avail = tester.getTopLeft(find.text('Availability Available → Unavailable')).dy;
      expect(stock < price && price < avail, isTrue);
      expect(find.textContaining('Deligro'), findsWidgets);
      expect(find.textContaining('vendor'), findsWidgets);
    });

    testWidgets('only allowed actions are offered — no stock change without it', (tester) async {
      await _detail(tester);
      expect(find.byKey(const Key('product-action-flag')), findsOneWidget);
      expect(find.byKey(const Key('product-action-hide')), findsOneWidget);
      expect(find.byKey(const Key('product-action-approve')), findsOneWidget);
      expect(find.byKey(const Key('product-action-unhide')), findsNothing);
      expect(find.byKey(const Key('product-action-stock')), findsNothing);
    });

    testWidgets('hiding needs a reason', (tester) async {
      final fake = await _detail(tester);
      await _act(tester, 'product-action-hide');
      expect(tester.widget<FilledButton>(find.byKey(const Key('reason-submit'))).onPressed, isNull);
      await tester.enterText(find.byKey(const Key('reason-field')), 'Wrong photo of a different dish');
      await tester.pump();
      await tester.tap(find.byKey(const Key('reason-submit')));
      await tester.pumpAndSettle();
      expect(fake.actCalls.single.action, isA<HideListing>());
      expect(fake.actCalls.single.action.reason, 'Wrong photo of a different dish');
    });

    testWidgets('stock: a negative number is refused; "Stop tracking" sends null', (tester) async {
      final fake = FakeProductsRepository(detail: fixtureProduct(patch: {
        'allowed': {'flag': true, 'adjustStock': true},
      }));
      await _detail(tester, repo: fake, perms: {..._moderator, 'manager.products.adjust_stock'});
      await _act(tester, 'product-action-stock');
      await tester.enterText(find.byKey(const Key('stock-qty')), '-3');
      await tester.enterText(find.byKey(const Key('stock-reason')), 'Recount at the shop');
      await tester.pump();
      expect(find.text('Enter 0 or more'), findsOneWidget);
      expect(tester.widget<FilledButton>(find.byKey(const Key('stock-save'))).onPressed, isNull);

      await tester.tap(find.byKey(const Key('stock-stop-tracking')));
      await tester.pump();
      expect(tester.widget<FilledButton>(find.byKey(const Key('stock-save'))).onPressed, isNotNull);
      await tester.tap(find.byKey(const Key('stock-save')));
      await tester.pumpAndSettle();
      final a = fake.actCalls.single.action as AdjustStock;
      expect(a.stockQty, isNull);
      expect(a.reason, 'Recount at the shop');
    });

    testWidgets('approving a listing that is no longer pending says so and refreshes', (tester) async {
      final fake = FakeProductsRepository()..actOutcomes.add(const Refused('invalid_transition'));
      await _detail(tester, repo: fake);
      final before = fake.detailCalls.length;
      await _act(tester, 'product-action-approve');
      await tester.tap(find.text('Price checked').last);
      await tester.pump();
      await tester.tap(find.byKey(const Key('reason-submit')));
      await tester.pumpAndSettle();
      expect(find.text('This listing is no longer waiting for approval.'), findsOneWidget);
      expect(fake.detailCalls.length, greaterThan(before));
    });
  });

  testWidgets('insights show hours unavailable', (tester) async {
    await pumpVp(tester, const ProductInsightsScreen(), permissions: productViewer, size: const Size(400, 1600));
    await tester.pumpAndSettle();
    expect(find.text('31.5 h unavailable'), findsOneWidget);
    expect(find.text('FREQUENTLY UNAVAILABLE'), findsOneWidget);
    expect(find.textContaining('+12.5%'), findsOneWidget);
  });

  testWidgets('restricted categories: adding one asks why', (tester) async {
    final fake = FakeProductsRepository();
    await pumpVp(tester, const RestrictedCategoriesScreen(), products: fake, permissions: _moderator, role: 'admin');
    await tester.pumpAndSettle();
    expect(find.text('Beverages'), findsOneWidget);
    await tester.tap(find.byKey(const Key('restricted-add')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('restricted-name')), 'Energy drinks');
    await tester.enterText(find.byKey(const Key('reason-field')), 'Age-restricted items');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await tester.pumpAndSettle();
    expect(fake.restrictCalls.single, (name: 'Energy drinks', restricted: true, reason: 'Age-restricted items'));
    expect(find.text('Energy drinks'), findsOneWidget);
  });

  test('an insights range is at most 92 days and never ends after today (IST)', () {
    final now = DateTime.utc(2026, 10, 21, 20, 0); // 01:30 on 22 Oct in India
    expect(insightsRangeProblem(DateTime(2026, 7, 1), DateTime(2026, 10, 21), now: now), 'Pick 92 days or fewer.');
    expect(insightsRangeProblem(DateTime(2026, 7, 23), DateTime(2026, 10, 22), now: now), isNull);
    expect(insightsRangeProblem(DateTime(2026, 10, 1), DateTime(2026, 10, 23), now: now), "The range can't end after today.");
    expect(const InsightsRange.days(90).bounds(now), ('2026-07-25', '2026-10-22'));
  });

  testWidgets('a product action applied without the listing sent back re-reads it', (tester) async {
    final fake = FakeProductsRepository()..actOutcomes.add(const Applied<ProductDetail>());
    await _detail(tester, repo: fake);
    final before = fake.detailCalls.length;
    await _act(tester, 'product-action-hide');
    await tester.tap(find.text('Wrong photo'));
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await tester.pumpAndSettle();
    expect(fake.detailCalls.length, greaterThan(before));
  });

  group('replace a wrong photo', () {
    const replacer = {..._moderator, 'manager.products.replace_photo'};
    FakeProductsRepository replaceable() => FakeProductsRepository(
          detail: fixtureProduct(patch: {
            'allowed': {'flag': true, 'replacePhoto': true},
          }),
        );

    testWidgets('replace sheet offers camera, gallery and library', (tester) async {
      await _detail(tester, repo: replaceable(), perms: replacer);
      await _act(tester, 'product-action-replace-photo');
      expect(find.byKey(const Key('replace-camera')), findsOneWidget);
      expect(find.byKey(const Key('replace-gallery')), findsOneWidget);
      expect(find.byKey(const Key('replace-library')), findsOneWidget);
    });

    testWidgets('library tab shows suggestions and searching calls photoSuggestions with q', (tester) async {
      final fake = await _detail(tester, repo: replaceable(), perms: replacer);
      await _act(tester, 'product-action-replace-photo');
      await tester.tap(find.byKey(const Key('replace-library')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('library-photo-lib-1')), findsOneWidget);
      expect(fake.suggestionCalls.single.q, isNull, reason: 'best matches for the dish first');
      await tester.enterText(find.byKey(const Key('library-search')), 'biryani');
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      expect(fake.suggestionCalls.last.q, 'biryani');
    });

    testWidgets('product detail hides Replace photo when allowed.replacePhoto is false', (tester) async {
      await _detail(tester, perms: replacer);
      expect(find.byKey(const Key('product-action-replace-photo')), findsNothing);
    });

    testWidgets('choosing a library photo calls replacePhotoFromLibrary with the review change id', (tester) async {
      final fake = FakeProductsRepository();
      final card = fake.imageReviewsValue.items.first;
      await pumpVp(tester, const ImageReviewsScreen(), products: fake, permissions: replacer, size: const Size(400, 1000));
      await tester.pumpAndSettle();
      await _act(tester, 'image-review-replace-${card.changeId}');
      await tester.tap(find.byKey(const Key('replace-library')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('library-photo-lib-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('replace-confirm')));
      await tester.pumpAndSettle();
      expect(fake.photoCalls.single, (id: card.product.id, libraryImageId: 'lib-1', fileName: null, reviewChangeId: card.changeId));
    });

    testWidgets('a successful replace from Image reviews removes that card', (tester) async {
      final fake = FakeProductsRepository();
      final card = fake.imageReviewsValue.items.first;
      await pumpVp(
        tester,
        const ImageReviewsScreen(),
        products: fake,
        permissions: replacer,
        size: const Size(400, 1000),
        extra: [
          dishPhotoPickerProvider.overrideWithValue((_) async => XFile.fromData(Uint8List.fromList([1, 2, 3]), name: 'dish.jpg', path: 'dish.jpg')),
        ],
      );
      await tester.pumpAndSettle();
      await _act(tester, 'image-review-replace-${card.changeId}');
      await tester.tap(find.byKey(const Key('replace-gallery')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('replace-confirm')));
      await tester.pumpAndSettle();
      expect(fake.photoCalls.single.fileName, 'dish.jpg');
      expect(find.byKey(Key('image-review-replace-${card.changeId}')), findsNothing);
      expect(find.text('Photo replaced. The shop has been told.'), findsOneWidget);
    });

    testWidgets('no Replace on review cards without manager.products.replace_photo', (tester) async {
      final fake = FakeProductsRepository();
      await pumpVp(tester, const ImageReviewsScreen(), products: fake, permissions: _moderator, size: const Size(400, 1000));
      await tester.pumpAndSettle();
      expect(find.textContaining('Replace'), findsNothing);
    });
  });
}
