import '../core/api.dart';
import '../models/manager_me.dart';

/// The Manager app's own routes (`/api/manager/*`).
class ManagerRepository {
  ManagerRepository(this._api);
  final ApiClient _api;

  Future<ManagerMe> me() async => ManagerMe.fromJson(await _api.get('/api/manager/me'));
}
