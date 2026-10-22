import '../core/api.dart';
import '../models/earnings.dart';

/// The rider's money: `/api/rider/earnings/*`. [ApiEarningsRepository] talks to
/// the website; a debug build can swap in the fixture backend
/// (data/fixtures/fixture_earnings.dart).
///
/// Every method throws [ApiException]: 403 `feature_disabled` (the Earnings
/// switch is off for this rider), 429, 503 `migration_pending` or a dead
/// connection. Reads only: nothing here writes.
abstract interface class EarningsRepository {
  /// `GET /api/rider/earnings/summary`.
  Future<EarningsSummary> summary();

  /// `GET /api/rider/earnings/records` for the IST days [from]..[to],
  /// newest first. 400 `invalid_range` past 366 days.
  Future<RecordsPage> records({
    required String from,
    required String to,
    String? cursor,
    int limit = 50,
  });

  /// `GET /api/rider/earnings/payouts`, newest first.
  Future<List<Payout>> payouts();

  /// `GET /api/rider/earnings/incentives`.
  Future<List<IncentiveProgress>> incentives();

  /// `GET /api/rider/earnings/statement` for [from]..[to] (at most 366 days).
  Future<Statement> statement(String from, String to);
}

class ApiEarningsRepository implements EarningsRepository {
  ApiEarningsRepository(this._api);

  final ApiClient _api;

  Future<T> _read<T>(
    Future<Map<String, dynamic>> call,
    T Function(Map<String, dynamic> j) parse,
  ) async {
    final res = await call;
    try {
      return parse(res);
    } on FormatException {
      throw ApiException(500, 'bad_response');
    } on TypeError {
      throw ApiException(500, 'bad_response');
    }
  }

  @override
  Future<EarningsSummary> summary() =>
      _read(_api.get('/api/rider/earnings/summary'), EarningsSummary.fromJson);

  @override
  Future<RecordsPage> records({
    required String from,
    required String to,
    String? cursor,
    int limit = 50,
  }) => _read(
    _api.get(
      '/api/rider/earnings/records',
      query: {'from': from, 'to': to, 'limit': '$limit', 'cursor': ?cursor},
    ),
    RecordsPage.fromJson,
  );

  @override
  Future<List<Payout>> payouts() => _read(
    _api.get('/api/rider/earnings/payouts'),
    (j) => [
      for (final e in (j['payouts'] as List? ?? const []))
        if (e is Map) Payout.fromJson(Map<String, dynamic>.from(e)),
    ],
  );

  @override
  Future<List<IncentiveProgress>> incentives() => _read(
    _api.get('/api/rider/earnings/incentives'),
    (j) => [
      for (final e in (j['incentives'] as List? ?? const []))
        if (e is Map) IncentiveProgress.fromJson(Map<String, dynamic>.from(e)),
    ],
  );

  @override
  Future<Statement> statement(String from, String to) => _read(
    _api.get('/api/rider/earnings/statement', query: {'from': from, 'to': to}),
    Statement.fromJson,
  );
}
