import '../core/api.dart';
import '../models/report.dart';

/// Reports (§13) — `/api/manager/reports*`.
abstract interface class ReportsRepository {
  /// Only the kinds this manager may run, in the server's order.
  Future<ReportKindList> kinds();

  /// One page, or every row with [all] (export). 413 `too_large` throws
  /// [ReportTooLarge]; other faults throw [ApiException].
  Future<ReportPayload> run(ReportQuery q, {bool all = false});
}

class ApiReportsRepository implements ReportsRepository {
  ApiReportsRepository(this._api);
  final ApiClient _api;

  @override
  Future<ReportKindList> kinds() async => ReportKindList.fromJson(await _api.get('/api/manager/reports/kinds'));

  @override
  Future<ReportPayload> run(ReportQuery q, {bool all = false}) async {
    try {
      return ReportPayload.fromJson(await _api.get('/api/manager/reports', query: q.toQuery(all: all)));
    } on ApiException catch (e) {
      if (e.status == 413 || e.code == 'too_large') {
        final rows = e.body['rows'], max = e.body['max'];
        throw ReportTooLarge(rows: rows is num ? rows.round() : 0, max: max is num ? max.round() : 10000);
      }
      rethrow;
    }
  }
}
