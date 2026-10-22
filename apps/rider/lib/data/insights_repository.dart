import '../core/api.dart';
import '../models/dashboard.dart';
import '../models/insights.dart';

/// What the rider did, as `/api/rider/{dashboard,history,performance}` tell it.
/// [ApiInsightsRepository] talks to the website; a debug build can swap in the
/// fixture backend (data/fixtures/fixture_insights.dart).
///
/// Every method throws [ApiException] (403 `feature_disabled`, 429, 503
/// `migration_pending` or a dead connection). Reads only: nothing here writes.
abstract interface class InsightsRepository {
  /// `GET /api/rider/dashboard`: Home's twelve figures.
  Future<RiderDashboard> dashboard();

  /// `GET /api/rider/history`: finished jobs, newest first, 20 a page.
  /// [from]/[to] are IST `YYYY-MM-DD` days the job ended on (at most 366
  /// apart); [outcome] is a [HistoryOutcome.wire].
  Future<HistoryPage> history({
    String? from,
    String? to,
    String? outcome,
    String? cursor,
  });

  /// `GET /api/rider/history/:orderId`. 404 `not_found` for an order the
  /// rider has not finished.
  Future<HistoryDetail> historyDetail(String orderId);

  /// `GET /api/rider/performance`.
  Future<RiderPerformance> performance();
}

class ApiInsightsRepository implements InsightsRepository {
  ApiInsightsRepository(this._api);

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
  Future<RiderDashboard> dashboard() =>
      _read(_api.get('/api/rider/dashboard'), RiderDashboard.fromJson);

  @override
  Future<HistoryPage> history({
    String? from,
    String? to,
    String? outcome,
    String? cursor,
  }) => _read(
    _api.get(
      '/api/rider/history',
      query: {'from': ?from, 'to': ?to, 'outcome': ?outcome, 'cursor': ?cursor},
    ),
    HistoryPage.fromJson,
  );

  @override
  Future<HistoryDetail> historyDetail(String orderId) => _read(
    _api.get('/api/rider/history/${Uri.encodeComponent(orderId)}'),
    HistoryDetail.fromJson,
  );

  @override
  Future<RiderPerformance> performance() =>
      _read(_api.get('/api/rider/performance'), RiderPerformance.fromJson);
}
