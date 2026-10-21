import '../core/api.dart';
import '../models/outcome.dart';
import '../models/payment_request.dart';

/// Maker–checker payment requests — `/api/manager/payments/requests*`.
abstract interface class PaymentsRepository {
  Future<PaymentRequestPage> list(PaymentRequestFilters f, {String? cursor});

  /// 201 → [Applied]; 409 `nothing_to_pay` / `duplicate_pending` → [Refused].
  Future<Outcome<PaymentRequest>> request(PayoutRequestDraft d);

  /// 403 `same_person`, 409 `amount_changed` (new amount in `reasons`),
  /// `already_decided` … → [Refused]; faults throw so Retry re-sends the
  /// same decision.
  Future<Outcome<PaymentRequest>> decide(String id, PaymentDecision d);
}

class ApiPaymentsRepository implements PaymentsRepository {
  ApiPaymentsRepository(this._api);
  final ApiClient _api;

  static const _base = '/api/manager/payments/requests';

  PaymentRequest? _one(Map<String, dynamic> res) =>
      res['request'] is Map ? PaymentRequest.fromJson((res['request'] as Map).cast<String, dynamic>()) : null;

  @override
  Future<PaymentRequestPage> list(PaymentRequestFilters f, {String? cursor}) async =>
      PaymentRequestPage.fromJson(await _api.get(_base, query: {...f.toQuery(), 'cursor': ?cursor}));

  @override
  Future<Outcome<PaymentRequest>> request(PayoutRequestDraft d) => runAction(() => _api.post(_base, d.toJson()), _one);

  @override
  Future<Outcome<PaymentRequest>> decide(String id, PaymentDecision d) =>
      runAction(() => _api.post('$_base/${Uri.encodeComponent(id)}/decide', d.toJson()), _one);
}
