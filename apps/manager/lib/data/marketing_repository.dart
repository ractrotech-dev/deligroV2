import 'package:cross_file/cross_file.dart';

import '../core/api.dart';
import '../models/marketing.dart';
import '../models/outcome.dart';

/// Vendor marketing requests and campaigns (§8) — `/api/manager/marketing/*`.
abstract interface class MarketingRepository {
  Future<MarketingRequestPage> requests(RequestFilters f, {String? cursor});
  Future<RequestBundle> request(String id);

  /// Records a request for a vendor (after a phone call).
  Future<Outcome<MarketingRequest>> createRequest(NewRequestInput input);

  /// 409 `stale`, `slot_taken`, `code_taken`, `consent_required`; 422
  /// `reason_required` → [Refused]. A fault throws, so Retry resends [d]
  /// (same `clientActionId`).
  Future<Outcome<RequestBundle>> decide(String id, RequestDecision d);
  Future<Outcome<MarketingRequest>> progress(String id, RequestProgress p);

  Future<CampaignPage> campaigns(CampaignFilters f, {String? cursor});
  Future<CampaignBundle> campaign(String id, {String? from, String? to});
  Future<Outcome<CampaignDetail>> createCampaign(CampaignInput input, {required String clientActionId});
  Future<Outcome<CampaignDetail>> updateCampaign(String id, CampaignEdit edit);
  Future<Outcome<CampaignDetail>> actOnCampaign(String id, CampaignAction a);

  /// jpeg/png ≤ 2 MB; [Applied] carries the public image URL.
  Future<Outcome<String>> uploadImage(String campaignId, XFile file);
}

const marketingPageSize = 50;

class ApiMarketingRepository implements MarketingRepository {
  ApiMarketingRepository(this._api);
  final ApiClient _api;

  static const _base = '/api/manager/marketing';
  String _req(String id) => '$_base/requests/${Uri.encodeComponent(id)}';
  String _camp(String id) => '$_base/campaigns/${Uri.encodeComponent(id)}';

  static Map<String, dynamic> _m(Object? v) => v is Map ? v.cast<String, dynamic>() : const {};

  @override
  Future<MarketingRequestPage> requests(RequestFilters f, {String? cursor}) async => MarketingRequestPage.fromJson(
        await _api.get('$_base/requests', query: {...f.toQuery(), 'cursor': ?cursor, 'limit': '$marketingPageSize'}),
      );

  @override
  Future<RequestBundle> request(String id) async => RequestBundle.fromJson(await _api.get(_req(id)));

  @override
  Future<Outcome<MarketingRequest>> createRequest(NewRequestInput input) => runAction(
        () => _api.post('$_base/requests', input.toJson()),
        (res) => res['request'] is Map ? MarketingRequest.fromJson(_m(res['request'])) : null,
      );

  @override
  Future<Outcome<RequestBundle>> decide(String id, RequestDecision d) => runAction(
        () => _api.post('${_req(id)}/decide', d.toJson()),
        (res) => res['request'] is Map ? RequestBundle.fromJson(res) : null,
      );

  @override
  Future<Outcome<MarketingRequest>> progress(String id, RequestProgress p) => runAction(
        () => _api.post('${_req(id)}/progress', p.toJson()),
        (res) => res['request'] is Map ? MarketingRequest.fromJson(_m(res['request'])) : null,
      );

  @override
  Future<CampaignPage> campaigns(CampaignFilters f, {String? cursor}) async => CampaignPage.fromJson(
        await _api.get('$_base/campaigns', query: {...f.toQuery(), 'cursor': ?cursor, 'limit': '$marketingPageSize'}),
      );

  @override
  Future<CampaignBundle> campaign(String id, {String? from, String? to}) async =>
      CampaignBundle.fromJson(await _api.get(_camp(id), query: {'from': ?from, 'to': ?to}));

  CampaignDetail? _detail(Map<String, dynamic> res) =>
      res['campaign'] is Map ? CampaignDetail.fromJson(_m(res['campaign'])) : null;

  @override
  Future<Outcome<CampaignDetail>> createCampaign(CampaignInput input, {required String clientActionId}) => runAction(
        () => _api.post('$_base/campaigns', {...input.toJson(), 'clientActionId': clientActionId}),
        _detail,
      );

  @override
  Future<Outcome<CampaignDetail>> updateCampaign(String id, CampaignEdit edit) =>
      runAction(() => _api.patch(_camp(id), edit.toJson()), _detail);

  @override
  Future<Outcome<CampaignDetail>> actOnCampaign(String id, CampaignAction a) =>
      runAction(() => _api.post('${_camp(id)}/actions', a.toJson()), _detail);

  @override
  Future<Outcome<String>> uploadImage(String campaignId, XFile file) async {
    final bytes = await file.readAsBytes();
    return runAction(
      () => _api.postMultipart('${_camp(campaignId)}/image', fields: const {}, fileField: 'file', bytes: bytes, fileName: file.name),
      (res) => res['imageUrl'] is String ? res['imageUrl'] as String : null,
    );
  }
}
