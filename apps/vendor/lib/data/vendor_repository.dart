import '../core/api.dart';
import '../models/vendor_me.dart';

class VendorRepository {
  VendorRepository(this._api);

  final ApiClient _api;

  Future<VendorMe> me() async => VendorMe.fromJson(await _api.get('/api/vendor/me'));
}
