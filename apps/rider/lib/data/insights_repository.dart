import '../core/api.dart';
import '../models/dashboard.dart';

/// What the rider did, as `/api/rider/{dashboard,history,performance}` tell it.
/// [ApiInsightsRepository] talks to the website; a debug build can swap in the
/// fixture backend (data/fixtures/fixture_insights.dart).
///
/// Every method throws [ApiException] (403 `feature_disabled`, 429, 503
/// `migration_pending` or a dead connection). Reads only: nothing here writes.
abstract interface class InsightsRepository {
  /// `GET /api/rider/dashboard`: Home's twelve figures.
  Future<RiderDashboard> dashboard();
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
}
