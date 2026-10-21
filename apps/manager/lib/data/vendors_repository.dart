import 'package:cross_file/cross_file.dart';

import '../core/api.dart';
import '../models/orders.dart' show VendorRef;
import '../models/outcome.dart';
import '../models/tickets.dart';
import '../models/vendors.dart';

/// Vendors across this manager's zones (§4) — `/api/manager/vendors*`.
abstract interface class VendorsRepository {
  Future<VendorPage> list(VendorFilters f, {String? cursor});

  /// Every shop in scope, by name — the vendor picker on Orders, Products and
  /// Statistics (`GET /api/manager/vendors/directory`).
  Future<List<VendorRef>> directory({String? zoneId});
  Future<VendorDetail> detail(String id);
  Future<ReviewPage> reviews(String id, {String? cursor});

  /// A 60-second signed URL for one document file.
  Future<String> documentUrl(String id, String docId);
  Future<TicketPage> complaints(String id, {String? cursor});

  /// Refusals come back as [Refused]; a network or server fault throws
  /// [ApiException], so the caller retries the same action (same id).
  Future<Outcome<VendorDetail>> act(String id, VendorAction a);

  /// 201 → [Applied] with the new shop; 409 `phone_taken` / `email_taken`,
  /// 400 with `field`, 404 zone out of scope → [Refused].
  Future<Outcome<OnboardResult>> onboard(OnboardDraft d, String clientActionId);

  Future<Outcome<VendorDocument>> upload(String id, String type, XFile file, String clientActionId);

  /// A shop logo uploaded before the shop exists (§4.2); [Applied] carries its URL,
  /// which goes into the onboarding form as `logoUrl`.
  Future<Outcome<String>> uploadLogo(XFile file);
}

/// Contract default page size.
const vendorPageSize = 50;

class ApiVendorsRepository implements VendorsRepository {
  ApiVendorsRepository(this._api);
  final ApiClient _api;

  String _p(String id) => '/api/manager/vendors/${Uri.encodeComponent(id)}';

  @override
  Future<VendorPage> list(VendorFilters f, {String? cursor}) async => VendorPage.fromJson(
        await _api.get('/api/manager/vendors', query: {...f.toQuery(), 'cursor': ?cursor, 'limit': '$vendorPageSize'}),
      );

  @override
  Future<List<VendorRef>> directory({String? zoneId}) async {
    final j = await _api.get('/api/manager/vendors/directory', query: {'zone': ?zoneId});
    return [
      for (final v in (j['vendors'] as List? ?? const []))
        VendorRef.fromJson((v as Map).cast<String, dynamic>()),
    ];
  }

  @override
  Future<VendorDetail> detail(String id) async =>
      VendorDetail.fromJson(((await _api.get(_p(id)))['vendor'] as Map).cast<String, dynamic>());

  @override
  Future<ReviewPage> reviews(String id, {String? cursor}) async =>
      ReviewPage.fromJson(await _api.get('${_p(id)}/reviews', query: {'cursor': ?cursor}));

  @override
  Future<String> documentUrl(String id, String docId) async =>
      '${(await _api.get('${_p(id)}/documents/${Uri.encodeComponent(docId)}/url'))['url']}';

  @override
  Future<TicketPage> complaints(String id, {String? cursor}) async =>
      TicketPage.fromJson(await _api.get('${_p(id)}/complaints', query: {'cursor': ?cursor}));

  @override
  Future<Outcome<VendorDetail>> act(String id, VendorAction a) => runAction(
        () => _api.post('${_p(id)}/actions', a.toJson()),
        (res) => res['vendor'] is Map ? VendorDetail.fromJson((res['vendor'] as Map).cast<String, dynamic>()) : null,
      );

  @override
  Future<Outcome<OnboardResult>> onboard(OnboardDraft d, String clientActionId) => runAction(
        () => _api.post('/api/manager/vendors', d.toRequest(clientActionId)),
        OnboardResult.fromJson,
      );

  @override
  Future<Outcome<String>> uploadLogo(XFile file) async {
    final bytes = await file.readAsBytes();
    return runAction(
      () => _api.postMultipart('/api/manager/vendors/logo', fields: const {}, fileField: 'file', bytes: bytes, fileName: file.name),
      (res) => res['logoUrl'] is String ? res['logoUrl'] as String : null,
    );
  }

  @override
  Future<Outcome<VendorDocument>> upload(String id, String type, XFile file, String clientActionId) async {
    final bytes = await file.readAsBytes();
    return runAction(
      () => _api.postMultipart(
        '${_p(id)}/documents',
        fields: {'type': type, 'clientActionId': clientActionId},
        fileField: 'file',
        bytes: bytes,
        fileName: file.name,
      ),
      (res) => res['document'] is Map ? VendorDocument.fromJson((res['document'] as Map).cast<String, dynamic>()) : null,
    );
  }
}
