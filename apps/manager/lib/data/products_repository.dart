import '../core/api.dart';
import '../models/outcome.dart';
import '../models/products.dart';

/// Products across this manager's vendors (§12) — `/api/manager/products*`.
abstract interface class ProductsRepository {
  Future<ProductPage> list(ProductFilters f, {String? cursor});
  Future<List<CategoryRow>> categories({String? zoneId, String? vendorId});
  Future<ProductDetail> detail(String id);
  Future<ProductInsights> insights({required String from, required String to, String? zoneId, String? vendorId});

  /// Refusals → [Refused]; faults throw [ApiException] (retry, same id).
  Future<Outcome<ProductDetail>> act(String id, ProductAction a);
  Future<List<RestrictedCategory>> restricted();
  Future<Outcome<List<RestrictedCategory>>> setRestricted({
    required String name,
    required bool restricted,
    required String reason,
    required String clientActionId,
  });

  /// Vendor photos waiting for a look (§12.7), newest first; [before] pages.
  Future<ImageReviewPage> imageReviews({int? before});

  /// "Looks fine" (`ok`) or `flag` with an [ImageFlagReason] wire value and a note.
  Future<Outcome<void>> reviewImage({
    required int changeId,
    required String outcome,
    String? flagReason,
    String? note,
    required String clientActionId,
  });
}

const productPageSize = 50;

class ApiProductsRepository implements ProductsRepository {
  ApiProductsRepository(this._api);
  final ApiClient _api;

  @override
  Future<ProductPage> list(ProductFilters f, {String? cursor}) async => ProductPage.fromJson(
        await _api.get('/api/manager/products', query: {...f.toQuery(), 'cursor': ?cursor, 'limit': '$productPageSize'}),
      );

  @override
  Future<List<CategoryRow>> categories({String? zoneId, String? vendorId}) async =>
      parseCategories(await _api.get('/api/manager/products/categories', query: {'zone': ?zoneId, 'vendor': ?vendorId}));

  @override
  Future<ProductDetail> detail(String id) async => ProductDetail.fromJson(
        ((await _api.get('/api/manager/products/${Uri.encodeComponent(id)}'))['product'] as Map).cast<String, dynamic>(),
      );

  @override
  Future<ProductInsights> insights({required String from, required String to, String? zoneId, String? vendorId}) async =>
      ProductInsights.fromJson(await _api.get('/api/manager/products/insights',
          query: {'from': from, 'to': to, 'zone': ?zoneId, 'vendor': ?vendorId}));

  @override
  Future<Outcome<ProductDetail>> act(String id, ProductAction a) => runAction(
        () => _api.post('/api/manager/products/${Uri.encodeComponent(id)}/actions', a.toJson()),
        (res) => res['product'] is Map ? ProductDetail.fromJson((res['product'] as Map).cast<String, dynamic>()) : null,
      );

  @override
  Future<List<RestrictedCategory>> restricted() async =>
      parseRestricted(await _api.get('/api/manager/products/restricted-categories'));

  @override
  Future<Outcome<List<RestrictedCategory>>> setRestricted({
    required String name,
    required bool restricted,
    required String reason,
    required String clientActionId,
  }) =>
      runAction(
        () => _api.post('/api/manager/products/restricted-categories', {
          'name': name,
          'restricted': restricted,
          'reason': reason,
          'clientActionId': clientActionId,
        }),
        parseRestricted,
      );

  @override
  Future<ImageReviewPage> imageReviews({int? before}) async => ImageReviewPage.fromJson(
        await _api.get('/api/manager/products/image-reviews', query: {'before': ?before?.toString(), 'limit': '$productPageSize'}),
      );

  @override
  Future<Outcome<void>> reviewImage({
    required int changeId,
    required String outcome,
    String? flagReason,
    String? note,
    required String clientActionId,
  }) =>
      runAction<void>(
        () => _api.post('/api/manager/products/image-reviews/$changeId', {
          'outcome': outcome,
          'flagReason': ?flagReason,
          'note': ?note,
          'clientActionId': clientActionId,
        }),
        (_) {},
      );
}
