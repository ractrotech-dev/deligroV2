import 'dart:typed_data';

import '../core/api.dart';
import '../models/bulk.dart';

/// One shop's whole menu as a sheet (`/api/manager/vendors/<id>/menu-sheet`):
/// download it (or an empty template), send the edited sheet back to see what
/// it would do, then apply it. New dishes and changes go live at once, except
/// restricted categories, which wait for approval by someone else.
class MenuSheetRepository {
  MenuSheetRepository(this._api);
  final ApiClient _api;

  static String _path(String vendorId) => '/api/manager/vendors/$vendorId/menu-sheet';

  Future<Uint8List> download({required String vendorId, required bool xlsx, bool template = false}) => _api.getBytes(
    _path(vendorId),
    query: {'format': xlsx ? 'xlsx' : 'csv', if (template) 'template': '1'},
  );

  /// [apply] false asks what the sheet would do and changes nothing.
  /// [clientActionId] stays the same for one picked file, so a retried apply
  /// is answered from the first one instead of adding the dishes twice.
  Future<BulkOutcome> send(String vendorId, List<int> bytes, String fileName, {required bool apply, required String clientActionId}) async =>
      BulkOutcome.fromJson(
        await _api.postMultipart(
          _path(vendorId),
          fields: {'mode': apply ? 'apply' : 'preview', 'clientActionId': clientActionId},
          fileField: 'file',
          bytes: bytes,
          fileName: fileName,
        ),
      );
}
