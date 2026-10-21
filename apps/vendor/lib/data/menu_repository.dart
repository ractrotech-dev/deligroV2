import 'dart:typed_data';

import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';
import '../models/menu.dart';

/// Products and inventory. Every write goes through `/api/vendor/menu*`;
/// only photos go straight to storage, into the shop's own folder of the
/// public `menu-images` bucket (its policy checks the folder is a shop this
/// account owns).
class MenuRepository {
  MenuRepository(this._api, this._storage);

  final ApiClient _api;
  final SupabaseStorageClient _storage;

  Future<Menu> load() async => Menu.fromJson(await _api.get('/api/vendor/menu'));

  /// Returns the new item's id.
  Future<String> create(Map<String, Object?> fields) async =>
      (await _api.post('/api/vendor/menu', fields))['id'] as String;

  Future<void> update(String id, Map<String, Object?> fields) => _api.patch('/api/vendor/menu/$id', fields);

  Future<void> delete(String id) => _api.delete('/api/vendor/menu/$id');

  Future<String> duplicate(String id) async => (await _api.post('/api/vendor/menu/$id/duplicate'))['id'] as String;

  Future<void> setOptions(String id, List<MenuOption> variants, List<AddonGroup> groups) =>
      _api.put('/api/vendor/menu/$id/options', {
        'variants': [for (final v in variants) v.toJson()],
        'addonGroups': [for (final g in groups) g.toJson()],
      });

  Future<void> reorder(List<String> ids) => _api.post('/api/vendor/menu/reorder', {'ids': ids});

  Future<int> renameCategory(String from, String to) async =>
      ((await _api.post('/api/vendor/menu/categories', {'from': from, 'to': to}))['moved'] as num?)?.toInt() ?? 0;

  /// Uploads a JPEG to `{restaurantId}/{stamp}.jpg` and returns its public URL.
  Future<String> uploadPhoto(String restaurantId, Uint8List bytes) async {
    final path = '$restaurantId/${DateTime.now().microsecondsSinceEpoch}.jpg';
    final bucket = _storage.from('menu-images');
    await bucket.uploadBinary(path, bytes, fileOptions: const FileOptions(contentType: 'image/jpeg', upsert: false));
    return bucket.getPublicUrl(path);
  }
}
