import 'dart:typed_data';

import 'package:cross_file/cross_file.dart';
import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/products/image_reviews_screen.dart';
import 'package:deligro_manager/features/products/product_detail_screen.dart';
import 'package:deligro_manager/features/products/restricted_categories_screen.dart';
import 'package:deligro_manager/features/vendors/onboard/onboard_flow.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/products.dart';
import 'package:deligro_manager/models/vendors.dart';
import 'package:deligro_manager/state/onboard_draft.dart';
import 'package:deligro_manager/widgets/document_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:latlong2/latlong.dart';

import 'fakes/fake_vendor_product_repositories.dart';
import 'fixtures/fixtures.dart';
import 'vp_helpers.dart';

const _moderator = {...productViewer, 'manager.products.moderate'};

/// A PNG signature and a few bytes: enough for the app's type check.
final _png = Uint8List.fromList([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 73, 72, 68, 82]);

Future<void> _tapKey(WidgetTester tester, String key) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(Key(key)));
  await tester.pumpAndSettle();
}

void main() {
  group('models', () {
    test('a stock change carries the count the manager saw', () {
      final a = AdjustStock(stockQty: 9, expectedStockQty: 7, reason: 'Recount');
      expect(a.toJson()['expectedStockQty'], 7);
      expect(a.toJson()['stockQty'], 9);
      final untracked = AdjustStock(stockQty: 5, expectedStockQty: null, reason: 'Start tracking');
      expect(untracked.toJson().containsKey('expectedStockQty'), isTrue);
      expect(untracked.toJson()['expectedStockQty'], isNull);
    });

    test('a refusal keeps the body\'s extra detail (the current stock on a stale answer)', () async {
      final out = await runAction<Object>(
        () async => throw ApiException(409, 'stale', body: const {'error': 'stale', 'currentStockQty': 4}),
        (_) => null,
      );
      expect(out, isA<Refused<Object>>());
      expect((out as Refused).extra['currentStockQty'], 4);
    });

    test('a cursor page answers counts: null — the first page\'s counts stand', () {
      final page = ProductPage.fromJson({'items': const [], 'nextCursor': null, 'counts': null});
      expect(page.counts, isNull);
    });

    test('onboarding sends the alternate mobile and the uploaded logo; the saved draft keeps both', () {
      const d = OnboardDraft(zoneId: 'z1', shopName: 'Spice Hub', mobile: '9812345678', altMobile: '9812300000',
          logoUrl: 'https://x.supabase.co/storage/v1/object/public/vendor-logos/a.png');
      expect(d.toRequest('c1')['altMobile'], '9812300000');
      expect(d.toRequest('c1')['logoUrl'], endsWith('a.png'));
      expect(d.toSaved()['altMobile'], '9812300000');
      expect(OnboardDraft.fromJson(d.toSaved()).logoUrl, endsWith('a.png'));
      expect(const OnboardDraft(mobile: '9812345678', altMobile: '12345').altMobileError, isNotNull);
      expect(const OnboardDraft(mobile: '9812345678', altMobile: '9812345678').altMobileError, 'Use a different number from the main one');
      expect(const OnboardDraft(mobile: '9812345678').altMobileError, isNull);
    });

    test('an image review row parses', () {
      final page = ImageReviewPage.fromJson({
        'items': [
          {
            'changeId': 41,
            'product': (apiFixture('products_list')['items'] as List).first,
            'previousImageUrl': null,
            'imageUrl': 'https://x/new.jpg',
            'changedAt': '2026-10-21T10:00:00.000Z',
            'changedBy': {'id': 'u9', 'name': 'Ravi'},
          }
        ],
        'nextBefore': 41,
      });
      expect(page.items.single.changeId, 41);
      expect(page.items.single.changedBy?.name, 'Ravi');
      expect(page.nextBefore, 41);
    });
  });

  group('stock', () {
    testWidgets('sends the count shown; a stale answer reopens the dialog with the new count', (tester) async {
      final fake = FakeProductsRepository(detail: fixtureProduct(patch: {
        'stockQty': 7,
        'allowed': {'flag': true, 'adjustStock': true},
      }))
        ..actOutcomes.add(const Refused('stale', [], null, {'currentStockQty': 4}));
      await pumpVp(tester, const ProductDetailScreen(productId: 'p-1'),
          products: fake, permissions: {..._moderator, 'manager.products.adjust_stock'}, size: const Size(400, 1400));
      await tester.pumpAndSettle();
      await _tapKey(tester, 'product-action-stock');
      await tester.enterText(find.byKey(const Key('stock-qty')), '9');
      await tester.enterText(find.byKey(const Key('stock-reason')), 'Recount at the shop');
      await tester.pump();
      await tester.tap(find.byKey(const Key('stock-save')));
      await tester.pumpAndSettle();

      final first = fake.actCalls.first.action as AdjustStock;
      expect(first.expectedStockQty, 7);
      expect(find.byKey(const Key('stock-stale-notice')), findsOneWidget);
      expect(find.textContaining('changed to 4'), findsOneWidget);

      await tester.enterText(find.byKey(const Key('stock-qty')), '6');
      await tester.enterText(find.byKey(const Key('stock-reason')), 'Recount at the shop');
      await tester.pump();
      await tester.tap(find.byKey(const Key('stock-save')));
      await tester.pumpAndSettle();
      final second = fake.actCalls.last.action as AdjustStock;
      expect(fake.actCalls, hasLength(2));
      expect(second.expectedStockQty, 4);
      expect(second.stockQty, 6);
      expect(second.clientActionId, isNot(first.clientActionId));
    });
  });

  group('restricted categories', () {
    testWidgets('a manager reads the list; only an admin can change it', (tester) async {
      await pumpVp(tester, const RestrictedCategoriesScreen(), permissions: _moderator);
      await tester.pumpAndSettle();
      expect(find.text('Beverages'), findsOneWidget);
      expect(find.byKey(const Key('restricted-add')), findsNothing);
      expect(find.byKey(const Key('restricted-remove-Beverages')), findsNothing);
      expect(find.byKey(const Key('restricted-admin-only')), findsOneWidget);
    });

    testWidgets('an admin can add and remove', (tester) async {
      await pumpVp(tester, const RestrictedCategoriesScreen(), permissions: _moderator, role: 'admin');
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('restricted-add')), findsOneWidget);
      expect(find.byKey(const Key('restricted-remove-Beverages')), findsOneWidget);
      expect(find.byKey(const Key('restricted-admin-only')), findsNothing);
    });
  });

  group('onboarding', () {
    Future<FakeVendorsRepository> flow(WidgetTester tester, {FakeVendorsRepository? repo, List<XFile> picks = const []}) async {
      final fake = repo ?? FakeVendorsRepository();
      final queue = [...picks];
      await pumpVp(
        tester,
        const OnboardFlow(),
        vendors: fake,
        permissions: {...vendorViewer, 'manager.vendors.onboard'},
        size: const Size(400, 1100),
        extra: [
          documentPickerProvider.overrideWithValue((_) async => queue.isEmpty ? null : queue.removeAt(0)),
          currentLocationProvider.overrideWithValue(() async => const LatLng(21.71, 81.53)),
        ],
      );
      return fake;
    }

    Future<void> next(WidgetTester tester) async {
      await tester.tap(find.byKey(const Key('onboard-next')));
      await tester.pumpAndSettle();
    }

    testWidgets('a logo is uploaded on the Shop step and an alternate mobile taken on the Owner step', (tester) async {
      final logo = XFile.fromData(_png, name: 'logo.png', path: 'logo.png', mimeType: 'image/png');
      final fake = await flow(tester, picks: [logo]);
      await tester.enterText(find.byKey(const Key('onboard-shop-name')), 'Spice Hub');
      await _tapKey(tester, 'onboard-logo');
      expect(find.textContaining('Pick a JPEG'), findsNothing, reason: 'the type guard refused the test file');
      expect(fake.logoCalls, ['logo.png']);
      expect(find.byKey(const Key('onboard-logo-done')), findsOneWidget);
      await next(tester);
      await tester.enterText(find.byKey(const Key('onboard-owner-name')), 'Anil Verma');
      await tester.enterText(find.byKey(const Key('onboard-mobile')), '9812345678');
      await tester.enterText(find.byKey(const Key('onboard-email')), 'anil@spicehub.in');
      await tester.enterText(find.byKey(const Key('onboard-alt-mobile')), '9812345678');
      await tester.pump();
      expect(find.text('Use a different number from the main one'), findsOneWidget);
      await tester.enterText(find.byKey(const Key('onboard-alt-mobile')), '9812300000');
      await tester.pump();
      await next(tester);
      await tester.enterText(find.byKey(const Key('onboard-address')), 'Station Road, Bemetara');
      await _tapKey(tester, 'onboard-use-location');
      await next(tester);
      await next(tester);
      await next(tester);
      await tester.tap(find.byKey(const Key('onboard-submit')));
      await tester.pumpAndSettle();
      final sent = fake.onboardCalls.single.draft;
      expect(sent.altMobile, '9812300000');
      expect(sent.logoUrl, fake.logoUrlValue);
    });

    testWidgets('"already has an account" after a retried send says the vendor may already exist', (tester) async {
      final fake = FakeVendorsRepository()
        ..onboardError = ApiException(0, 'network')
        ..onboardOutcomes.add(const Refused('email_taken'));
      await flow(tester, repo: fake);
      await tester.enterText(find.byKey(const Key('onboard-shop-name')), 'Spice Hub');
      await tester.pump();
      await next(tester);
      await tester.enterText(find.byKey(const Key('onboard-owner-name')), 'Anil Verma');
      await tester.enterText(find.byKey(const Key('onboard-mobile')), '9812345678');
      await tester.enterText(find.byKey(const Key('onboard-email')), 'anil@spicehub.in');
      await tester.pump();
      await next(tester);
      await tester.enterText(find.byKey(const Key('onboard-address')), 'Station Road, Bemetara');
      await _tapKey(tester, 'onboard-use-location');
      await next(tester);
      await next(tester);
      await next(tester);
      await tester.tap(find.byKey(const Key('onboard-submit')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Retry'));
      await tester.pumpAndSettle();
      expect(fake.onboardCalls, hasLength(2));
      expect(find.byKey(const Key('onboard-form-error')), findsOneWidget);
      expect(find.textContaining('may already exist'), findsOneWidget);
    });
  });

  group('photo review (§12.7)', () {
    testWidgets('"Looks fine" clears a photo; Flag needs a reason and a note', (tester) async {
      final fake = FakeProductsRepository();
      await pumpVp(tester, const ImageReviewsScreen(), products: fake, permissions: _moderator, size: const Size(400, 1000));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('image-review-ok-41')), findsOneWidget);
      await _tapKey(tester, 'image-review-ok-41');
      expect(fake.reviewCalls.single, (changeId: 41, outcome: 'ok', flagReason: null, note: null));
      expect(find.byKey(const Key('image-review-ok-41')), findsNothing);

      await _tapKey(tester, 'image-review-flag-42');
      await tester.tap(find.text('Not appropriate').last);
      await tester.pumpAndSettle();
      expect(tester.widget<FilledButton>(find.byKey(const Key('reason-submit'))).onPressed, isNull);
      await tester.enterText(find.byKey(const Key('reason-field')), 'Shows a person, not food');
      await tester.pump();
      await tester.tap(find.byKey(const Key('reason-submit')));
      await tester.pumpAndSettle();
      expect(fake.reviewCalls.last, (changeId: 42, outcome: 'flag', flagReason: 'inappropriate', note: 'Shows a person, not food'));
    });

    testWidgets('an empty queue says so', (tester) async {
      final fake = FakeProductsRepository()..imageReviewsValue = const ImageReviewPage(items: []);
      await pumpVp(tester, const ImageReviewsScreen(), products: fake, permissions: _moderator);
      await tester.pumpAndSettle();
      expect(find.text('No photos waiting for a look.'), findsOneWidget);
    });
  });
}
