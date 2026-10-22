import '../core/api.dart';
import '../models/offers.dart';
import '../models/outcome.dart';

/// Offers and promo codes (§9) — `/api/manager/offers*`.
abstract interface class OffersRepository {
  Future<OfferPage> list(OfferFilters f, {String? cursor});
  Future<OfferBundle> detail(String code, {String? from, String? to});

  /// 409 `code_taken`, `consent_required`, `out_of_scope`,
  /// `platform_wide_admin_only`; 400 with `field` → [Refused].
  Future<Outcome<OfferDetail>> create(OfferTerms terms, {required String clientActionId});

  /// 409 `stale` → [Refused] (someone else changed it; re-read).
  Future<Outcome<OfferDetail>> update(String code, OfferEdit edit);

  /// 409 `expired` (activate past expiry), `exhausted` → [Refused].
  Future<Outcome<OfferDetail>> act(String code, OfferAction a);
}

const offersPageSize = 50;

class ApiOffersRepository implements OffersRepository {
  ApiOffersRepository(this._api);
  final ApiClient _api;

  static const _base = '/api/manager/offers';
  String _p(String code) => '$_base/${Uri.encodeComponent(code)}';

  static OfferDetail? _offer(Map<String, dynamic> res) =>
      res['offer'] is Map ? OfferDetail.fromJson((res['offer'] as Map).cast<String, dynamic>()) : null;

  @override
  Future<OfferPage> list(OfferFilters f, {String? cursor}) async =>
      OfferPage.fromJson(await _api.get(_base, query: {...f.toQuery(), 'cursor': ?cursor, 'limit': '$offersPageSize'}));

  @override
  Future<OfferBundle> detail(String code, {String? from, String? to}) async =>
      OfferBundle.fromJson(await _api.get(_p(code), query: {'from': ?from, 'to': ?to}));

  @override
  Future<Outcome<OfferDetail>> create(OfferTerms terms, {required String clientActionId}) =>
      runAction(() => _api.post(_base, {...terms.toJson(), 'clientActionId': clientActionId}), _offer);

  @override
  Future<Outcome<OfferDetail>> update(String code, OfferEdit edit) => runAction(() => _api.patch(_p(code), edit.toJson()), _offer);

  @override
  Future<Outcome<OfferDetail>> act(String code, OfferAction a) => runAction(() => _api.post('${_p(code)}/actions', a.toJson()), _offer);
}
