import 'package:cross_file/cross_file.dart';

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

  /// Replace the dish photo with one from the phone. [reviewChangeId]: the
  /// review card it was replaced from, which then counts as reviewed.
  Future<Outcome<ProductDetail>> replacePhotoUpload(String id, XFile file, {int? reviewChangeId, required String clientActionId});

  /// Replace the dish photo with a Deligro library photo.
  Future<Outcome<ProductDetail>> replacePhotoFromLibrary(String id, String libraryImageId, {int? reviewChangeId, required String clientActionId});

  /// Library photos for this dish: best matches for its name, or a search for [q].
  Future<List<LibraryPhoto>> photoSuggestions(String id, {String? q});
}

const productPageSize = 50;

ProductDetail? _productOf(Map<String, dynamic> res) =>
    res['product'] is Map ? ProductDetail.fromJson((res['product'] as Map).cast<String, dynamic>()) : null;

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

  String _photo(String id) => '/api/manager/products/${Uri.encodeComponent(id)}/photo';

  @override
  Future<Outcome<ProductDetail>> replacePhotoUpload(String id, XFile file, {int? reviewChangeId, required String clientActionId}) async {
    final bytes = await file.readAsBytes();
    return runAction(
      () => _api.postMultipart(
        _photo(id),
        fields: {'clientActionId': clientActionId, if (reviewChangeId != null) 'reviewChangeId': '$reviewChangeId'},
        fileField: 'file',
        bytes: bytes,
        // The server reads the type from the name; a picker that gives none sent a JPEG.
        fileName: file.name.isNotEmpty ? file.name : 'photo.jpg',
      ),
      _productOf,
    );
  }

  @override
  Future<Outcome<ProductDetail>> replacePhotoFromLibrary(String id, String libraryImageId, {int? reviewChangeId, required String clientActionId}) =>
      runAction(
        () => _api.post(_photo(id), {'libraryImageId': libraryImageId, 'clientActionId': clientActionId, 'reviewChangeId': ?reviewChangeId}),
        _productOf,
      );

  @override
  Future<List<LibraryPhoto>> photoSuggestions(String id, {String? q}) async {
    final res = await _api.get('/api/manager/products/${Uri.encodeComponent(id)}/photo-suggestions', query: {'q': ?q});
    return [for (final i in (res['items'] as List? ?? const [])) if (i is Map) LibraryPhoto.fromJson(i.cast<String, dynamic>())];
  }
}
