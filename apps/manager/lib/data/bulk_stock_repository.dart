import 'dart:typed_data';

import '../core/api.dart';
import '../models/bulk.dart';

/// A shop's stock as a sheet (`/api/manager/products/bulk`): download the
/// dishes with their current counts, send the edited sheet back to see what it
/// would do, then apply it. A manager's sheet changes stock counts only.
class BulkStockRepository {
  BulkStockRepository(this._api);
  final ApiClient _api;

  static const _path = '/api/manager/products/bulk';

  /// The shop's dishes with their current stock, as a sheet to fill in.
  Future<Uint8List> download({required String vendorId, required bool xlsx}) =>
      _api.getBytes(_path, query: {'vendor': vendorId, 'format': xlsx ? 'xlsx' : 'csv'});

  /// [apply] false asks what the sheet would do and changes nothing.
  Future<BulkOutcome> send(String vendorId, List<int> bytes, String fileName, {required bool apply}) async =>
      BulkOutcome.fromJson(
        await _api.postMultipart(
          _path,
          fields: {'vendor': vendorId, 'mode': apply ? 'apply' : 'preview'},
          fileField: 'file',
          bytes: bytes,
          fileName: fileName,
        ),
      );
}
