import '../core/api.dart';
import '../models/store.dart';

/// The shop's storefront, hours and open state. Writes go through the
/// website's `/api/vendor/store*` routes, which act on the active shop only.
class StoreRepository {
  StoreRepository(this._api);

  final ApiClient _api;

  Future<StoreState> load() async => StoreState.fromJson(await _api.get('/api/vendor/store'));

  StoreInfo _store(Map<String, dynamic> res) => StoreInfo.fromJson((res['store'] as Map).cast<String, dynamic>());

  /// Any of the PATCH fields (see src/app/api/vendor/store/route.ts).
  Future<StoreInfo> update(Map<String, Object?> fields) async => _store(await _api.patch('/api/vendor/store', fields));

  /// Open, close until reopened, or close for [closeForMinutes].
  Future<StoreInfo> setOpen(bool open, {int? closeForMinutes}) async =>
      _store(await _api.post('/api/vendor/store/open', {'open': open, 'closeForMinutes': ?closeForMinutes}));

  /// Add [minutes] to every quote for [forMinutes]; 0 ends busy mode.
  Future<void> setBusy(int minutes, {int forMinutes = 60}) =>
      _api.post('/api/vendor/store/busy', {'minutes': minutes, 'forMinutes': forMinutes});

  Future<void> addHoliday(String startsOn, String endsOn, {String? note}) =>
      _api.post('/api/vendor/store/holidays', {'startsOn': startsOn, 'endsOn': endsOn, 'note': ?note});

  Future<void> deleteHoliday(String id) => _api.delete('/api/vendor/store/holidays/$id');
}
