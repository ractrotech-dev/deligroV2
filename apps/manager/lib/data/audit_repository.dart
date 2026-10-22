import '../core/api.dart';
import '../models/audit.dart';

/// The audit log — `/api/manager/audit*`. Read only.
abstract interface class AuditRepository {
  Future<AuditPage> list(AuditFilters f, {String? cursor});
  Future<AuditEntryDetail> entry(int id);
  Future<List<AuditActionDef>> actions();
}

class ApiAuditRepository implements AuditRepository {
  ApiAuditRepository(this._api);
  final ApiClient _api;

  static const _base = '/api/manager/audit';

  @override
  Future<AuditPage> list(AuditFilters f, {String? cursor}) async =>
      AuditPage.fromJson(await _api.get(_base, query: {...f.toQuery(), 'cursor': ?cursor}));

  @override
  Future<AuditEntryDetail> entry(int id) async => AuditEntryDetail.fromJson(await _api.get('$_base/$id'));

  @override
  Future<List<AuditActionDef>> actions() async => AuditActionDef.listFromJson(await _api.get('$_base/actions'));
}
