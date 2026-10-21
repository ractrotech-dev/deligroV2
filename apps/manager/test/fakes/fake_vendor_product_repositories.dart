import 'package:cross_file/cross_file.dart';
import 'package:deligro_manager/data/products_repository.dart';
import 'package:deligro_manager/data/tickets_repository.dart';
import 'package:deligro_manager/data/vendors_repository.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/products.dart';
import 'package:deligro_manager/models/tickets.dart';
import 'package:deligro_manager/models/vendors.dart';

import '../fixtures/fixtures.dart';

/// Pops the first queued item, or returns null.
T? _pop<T>(List<T> q) => q.isEmpty ? null : q.removeAt(0);

/// Throws and clears a one-shot error slot.
void _throwOnce(Object? Function() read, void Function() clear) {
  final e = read();
  if (e != null) {
    clear();
    throw e;
  }
}

Map<String, dynamic> fixtureVendorJson() => Map<String, dynamic>.from(apiFixture('vendor_detail')['vendor'] as Map);

VendorDetail fixtureVendor({bool finance = true}) {
  final j = fixtureVendorJson();
  if (!finance) j.remove('finance');
  return VendorDetail.fromJson(j);
}

ProductDetail fixtureProduct({Map<String, dynamic> patch = const {}}) {
  final j = Map<String, dynamic>.from(apiFixture('product_detail')['product'] as Map)..addAll(patch);
  return ProductDetail.fromJson(j);
}

class FakeVendorsRepository implements VendorsRepository {
  FakeVendorsRepository({VendorPage? page, VendorDetail? detail})
      : page = page ?? VendorPage.fromJson(apiFixture('vendors_list')),
        detailValue = detail ?? fixtureVendor();

  VendorPage page;
  final Map<String?, VendorPage> pages = {};
  VendorDetail detailValue;
  ReviewPage reviewPage = ReviewPage.fromJson(apiFixture('vendor_reviews'));
  TicketPage complaintPage = TicketPage(items: fixtureVendor().openComplaints);

  Object? listError;
  Object? detailError;
  Object? actError;
  Object? onboardError;

  final List<Outcome<VendorDetail>> actOutcomes = [];
  final List<Outcome<OnboardResult>> onboardOutcomes = [];

  /// Per upload call, in order; when empty the upload succeeds.
  final List<Object> uploadResults = [];

  final listCalls = <({VendorFilters filters, String? cursor})>[];
  final detailCalls = <String>[];
  final actCalls = <({String id, VendorAction action})>[];
  final onboardCalls = <({OnboardDraft draft, String clientActionId})>[];
  final uploadCalls = <({String id, String type, String name, String clientActionId})>[];
  final urlCalls = <String>[];

  @override
  Future<VendorPage> list(VendorFilters f, {String? cursor}) async {
    listCalls.add((filters: f, cursor: cursor));
    _throwOnce(() => listError, () => listError = null);
    return pages[cursor] ?? page;
  }

  @override
  Future<VendorDetail> detail(String id) async {
    detailCalls.add(id);
    _throwOnce(() => detailError, () => detailError = null);
    return detailValue;
  }

  @override
  Future<ReviewPage> reviews(String id, {String? cursor}) async => reviewPage;

  @override
  Future<String> documentUrl(String id, String docId) async {
    urlCalls.add(docId);
    return 'https://example.test/signed/$docId';
  }

  @override
  Future<TicketPage> complaints(String id, {String? cursor}) async => complaintPage;

  @override
  Future<Outcome<VendorDetail>> act(String id, VendorAction a) async {
    actCalls.add((id: id, action: a));
    _throwOnce(() => actError, () => actError = null);
    return _pop(actOutcomes) ?? Applied(detailValue);
  }

  @override
  Future<Outcome<OnboardResult>> onboard(OnboardDraft d, String clientActionId) async {
    onboardCalls.add((draft: d, clientActionId: clientActionId));
    _throwOnce(() => onboardError, () => onboardError = null);
    return _pop(onboardOutcomes) ?? const Applied(OnboardResult(id: 'v-new', slug: 'new-shop'));
  }

  @override
  Future<Outcome<VendorDocument>> upload(String id, String type, XFile file, String clientActionId) async {
    uploadCalls.add((id: id, type: type, name: file.name, clientActionId: clientActionId));
    final r = _pop(uploadResults);
    if (r is Exception || r is Error) throw r!;
    if (r is Outcome<VendorDocument>) return r;
    return Applied(VendorDocument(id: 'd-new', type: DocType.parse(type), fileName: file.name, status: DocStatus.pending));
  }
}

class FakeProductsRepository implements ProductsRepository {
  FakeProductsRepository({ProductPage? page, ProductDetail? detail})
      : page = page ?? ProductPage.fromJson(apiFixture('products_list')),
        detailValue = detail ?? fixtureProduct();

  ProductPage page;
  final Map<String?, ProductPage> pages = {};
  ProductDetail detailValue;
  List<CategoryRow> categoriesValue = parseCategories(apiFixture('product_categories'));
  ProductInsights insightsValue = ProductInsights.fromJson(apiFixture('product_insights'));
  List<RestrictedCategory> restrictedValue = const [RestrictedCategory(name: 'Beverages', note: 'Energy drinks')];

  Object? listError;
  Object? actError;
  final List<Outcome<ProductDetail>> actOutcomes = [];

  final listCalls = <({ProductFilters filters, String? cursor})>[];
  final detailCalls = <String>[];
  final actCalls = <({String id, ProductAction action})>[];
  final insightCalls = <({String from, String to})>[];
  final restrictCalls = <({String name, bool restricted, String reason})>[];

  @override
  Future<ProductPage> list(ProductFilters f, {String? cursor}) async {
    listCalls.add((filters: f, cursor: cursor));
    _throwOnce(() => listError, () => listError = null);
    return pages[cursor] ?? page;
  }

  @override
  Future<List<CategoryRow>> categories({String? zoneId, String? vendorId}) async => categoriesValue;

  @override
  Future<ProductDetail> detail(String id) async {
    detailCalls.add(id);
    return detailValue;
  }

  @override
  Future<ProductInsights> insights({required String from, required String to, String? zoneId, String? vendorId}) async {
    insightCalls.add((from: from, to: to));
    return insightsValue;
  }

  @override
  Future<Outcome<ProductDetail>> act(String id, ProductAction a) async {
    actCalls.add((id: id, action: a));
    _throwOnce(() => actError, () => actError = null);
    return _pop(actOutcomes) ?? Applied(detailValue);
  }

  @override
  Future<List<RestrictedCategory>> restricted() async => restrictedValue;

  @override
  Future<Outcome<List<RestrictedCategory>>> setRestricted({
    required String name,
    required bool restricted,
    required String reason,
    required String clientActionId,
  }) async {
    restrictCalls.add((name: name, restricted: restricted, reason: reason));
    restrictedValue = restricted
        ? [...restrictedValue, RestrictedCategory(name: name, note: reason)]
        : restrictedValue.where((c) => c.name != name).toList();
    return Applied(restrictedValue);
  }
}

class FakeTicketsRepository implements TicketsRepository {
  FakeTicketsRepository({TicketThread? thread}) : threadValue = thread ?? TicketThread.fromJson(apiFixture('ticket_thread'));

  TicketThread threadValue;
  Object? replyError;
  final List<Outcome<void>> statusOutcomes = [];

  final threadCalls = <String>[];
  final replyCalls = <TicketReply>[];
  final statusCalls = <TicketStatusChange>[];

  @override
  Future<TicketThread> thread(String id) async {
    threadCalls.add(id);
    return threadValue;
  }

  @override
  Future<Outcome<void>> reply(String id, TicketReply r) async {
    replyCalls.add(r);
    _throwOnce(() => replyError, () => replyError = null);
    return const Applied();
  }

  @override
  Future<Outcome<void>> setStatus(String id, TicketStatusChange s) async {
    statusCalls.add(s);
    return _pop(statusOutcomes) ?? const Applied();
  }
}
