import 'dart:typed_data';

import '../core/api.dart';
import '../models/bulk.dart';

/// Bulk menu and stock sheets (`/api/vendor/menu/bulk`): download the shop's
/// menu or a template, send a file back to see what it would do, then apply it.
class BulkRepository {
  BulkRepository(this._api);
  final ApiClient _api;

  static const _path = '/api/vendor/menu/bulk';

  /// The shop's current menu as a sheet (ids, prices, stock...) or a blank template.
  Future<Uint8List> download({required bool xlsx, required bool template}) =>
      _api.getBytes(_path, query: {'format': xlsx ? 'xlsx' : 'csv', if (template) 'template': '1'});

  /// [apply] false asks what the sheet would do and changes nothing.
  Future<BulkOutcome> send(List<int> bytes, String filename, {required bool apply}) async => BulkOutcome.fromJson(
    await _api.postFile(_path, bytes: bytes, filename: filename, fields: {'mode': apply ? 'apply' : 'preview'}),
  );
}
