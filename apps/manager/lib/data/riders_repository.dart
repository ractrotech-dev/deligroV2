import 'package:cross_file/cross_file.dart';

import '../core/api.dart';
import '../models/outcome.dart';
import '../models/rider.dart';

/// Riders across this manager's zones (§5) — `/api/manager/riders*`.
abstract interface class RidersRepository {
  Future<RiderPage> list(RiderFilters f, {String? cursor});
  Future<RiderDetail> detail(String id);
  Future<RiderHistoryPage> history(String id, {DateTime? from, DateTime? to, RiderOutcome? outcome, String? cursor});
  Future<RatingPage> ratings(String id, {String? cursor});
  Future<LedgerPage> ledger(String id, {DateTime? from, DateTime? to, LedgerStatus? status, String? cursor});

  /// A 60-second signed URL for one document file.
  Future<String> documentUrl(String id, String docId);

  /// Refusals come back as [Refused]; a network or server fault throws
  /// [ApiException], so the caller retries the same action (same id).
  Future<Outcome<RiderDetail>> act(String id, RiderAction a);

  /// 201 → [Applied] with the new rider; 409 `phone_taken` / `email_taken`,
  /// 400 with `field`, 404 zone out of scope → [Refused].
  Future<Outcome<RiderOnboardResult>> onboard(RiderOnboardDraft d, String clientActionId);

  Future<Outcome<RiderDocument>> upload(
    String id, {
    required RiderDocType type,
    required XFile file,
    String? number,
    DateTime? expiresOn,
    required String clientActionId,
  });
}

/// Contract default page size.
const riderPageSize = 50;

class ApiRidersRepository implements RidersRepository {
  ApiRidersRepository(this._api);
  final ApiClient _api;

  String _p(String id) => '/api/manager/riders/${Uri.encodeComponent(id)}';

  @override
  Future<RiderPage> list(RiderFilters f, {String? cursor}) async => RiderPage.fromJson(
        await _api.get('/api/manager/riders', query: {...f.toQuery(), 'cursor': ?cursor, 'limit': '$riderPageSize'}),
      );

  @override
  Future<RiderDetail> detail(String id) async =>
      RiderDetail.fromJson(((await _api.get(_p(id)))['rider'] as Map).cast<String, dynamic>());

  @override
  Future<RiderHistoryPage> history(String id, {DateTime? from, DateTime? to, RiderOutcome? outcome, String? cursor}) async =>
      RiderHistoryPage.fromJson(await _api.get('${_p(id)}/history', query: {
        if (from != null) 'from': ymd(from),
        if (to != null) 'to': ymd(to),
        if (outcome != null) 'outcome': outcome.name,
        'cursor': ?cursor,
      }));

  @override
  Future<RatingPage> ratings(String id, {String? cursor}) async =>
      RatingPage.fromJson(await _api.get('${_p(id)}/ratings', query: {'cursor': ?cursor}));

  @override
  Future<LedgerPage> ledger(String id, {DateTime? from, DateTime? to, LedgerStatus? status, String? cursor}) async =>
      LedgerPage.fromJson(await _api.get('${_p(id)}/ledger', query: {
        if (from != null) 'from': ymd(from),
        if (to != null) 'to': ymd(to),
        if (status != null && status != LedgerStatus.unknown) 'status': status.name,
        'cursor': ?cursor,
      }));

  @override
  Future<String> documentUrl(String id, String docId) async =>
      '${(await _api.get('${_p(id)}/documents/${Uri.encodeComponent(docId)}/url'))['url']}';

  @override
  Future<Outcome<RiderDetail>> act(String id, RiderAction a) => runAction(
        () => _api.post('${_p(id)}/actions', a.toJson()),
        (res) => res['rider'] is Map ? RiderDetail.fromJson((res['rider'] as Map).cast<String, dynamic>()) : null,
      );

  @override
  Future<Outcome<RiderOnboardResult>> onboard(RiderOnboardDraft d, String clientActionId) => runAction(
        () => _api.post('/api/manager/riders', d.toRequest(clientActionId)),
        RiderOnboardResult.fromJson,
      );

  @override
  Future<Outcome<RiderDocument>> upload(
    String id, {
    required RiderDocType type,
    required XFile file,
    String? number,
    DateTime? expiresOn,
    required String clientActionId,
  }) async {
    final bytes = await file.readAsBytes();
    return runAction(
      () => _api.postMultipart(
        '${_p(id)}/documents',
        fields: {
          'type': type.wire,
          'clientActionId': clientActionId,
          if (number != null && number.trim().isNotEmpty) 'number': number.trim(),
          if (expiresOn != null) 'expiresOn': ymd(expiresOn),
        },
        fileField: 'file',
        bytes: bytes,
        fileName: file.name,
      ),
      (res) => res['document'] is Map ? RiderDocument.fromJson((res['document'] as Map).cast<String, dynamic>()) : null,
    );
  }
}
