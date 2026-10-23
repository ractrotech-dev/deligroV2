import '../core/api.dart';

/// What came of one audited action on a vendor, a product or a ticket.
///
/// The order screens keep their own `ActionOutcome` (Phase 3); this is the
/// same idea made generic over what the server sends back after the change.
sealed class Outcome<T> {
  const Outcome();
}

/// Applied. [value] is the thing after the change, or null when the server
/// applied it but did not (or could not) send it back — the caller re-reads.
class Applied<T> extends Outcome<T> {
  const Applied([this.value]);
  final T? value;
}

/// The server said no, for a reason the manager can read.
class Refused<T> extends Outcome<T> {
  const Refused(this.code, [this.reasons = const [], this.field, this.extra = const {}]);
  final String code;

  /// Extra detail: the missing document types for `documents_unverified`,
  /// rider/eligibility reasons elsewhere.
  final List<String> reasons;

  /// For a 400: the request field the server rejected.
  final String? field;

  /// The rest of the refusal's body, e.g. `currentStockQty` on a stale stock change.
  final Map<String, dynamic> extra;

  @override
  String toString() => 'Refused($code, $reasons)';
}

/// Status codes whose `error` is a decision about this action, not a fault.
const refusalStatuses = {400, 403, 404, 409, 413, 429};

/// Runs [call] and turns the contract's refusals into [Refused]. A network or
/// server fault (5xx, `network`) and a 401 are rethrown, so the caller can
/// offer Retry with the same action — and so the same `clientActionId`.
Future<Outcome<T>> runAction<T>(
  Future<Map<String, dynamic>> Function() call,
  T? Function(Map<String, dynamic> res) parse,
) async {
  try {
    final res = await call();
    return Applied<T>(parse(res));
  } on ApiException catch (e) {
    if (!refusalStatuses.contains(e.status)) rethrow;
    final extra = e.body['missing'] ?? e.body['reasons'] ?? e.body['orders'];
    final field = e.body['field'];
    // `amount_changed` carries the new figure; it rides in [Refused.reasons]
    // as text so every refusal keeps one shape.
    final amount = e.body['amount'];
    return Refused<T>(
      e.status == 429 ? 'rate_limited' : e.code,
      [
        for (final r in (extra is List ? extra : const [])) if (r is String) r,
        if (amount is num) amount == amount.roundToDouble() ? '${amount.round()}' : '$amount',
      ],
      field is String ? field : null,
      e.body,
    );
  }
}
