import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/banner.dart';
import '../models/restaurant.dart';
import '../models/settings.dart';

/// Public catalog reads, straight from Supabase under RLS (anon or the
/// customer's JWT). `restaurants` is granted per column (migration 0024) —
/// only select columns listed here, never `*`.
class CatalogRepository {
  CatalogRepository(this._db);
  final SupabaseClient _db;

  static const _cols =
      'id, slug, name, tagline, is_open, image_url, accent_tint, cuisines, '
      'rating, rating_count, eta_min, eta_max, price_tier, cost_for_two, '
      'lat, lng, address, prep_minutes, busy_until, busy_extra_minutes, '
      'offer_expires_at, offer, promoted, sort_position';
  static const _menu =
      'menu_items(id, external_id, name, description, price, discount_price, '
      'veg, available, category, image_url, popular, bestseller)';

  // Popularity rules from src/lib/popularity.ts.
  static const _popularityDays = 30;
  static const _popularLimit = 8;
  static const _minRanked = 3;

  /// Approved shops: promoted first, then by name, with admin-pinned slots
  /// floated to the top in slot order (as listRestaurantsFromDb does).
  Future<List<Restaurant>> listRestaurants({bool withMenu = false}) async {
    final rows = await _db
        .from('restaurants')
        .select(withMenu ? '$_cols, $_menu' : _cols)
        .eq('approved', true)
        .order('promoted', ascending: false)
        .order('name');
    final list = [for (final r in rows) Restaurant.fromRow(r)];
    final pinned = list.where((r) => r.sortPosition != null).toList()
      ..sort((a, b) => a.sortPosition!.compareTo(b.sortPosition!));
    return [...pinned, ...list.where((r) => r.sortPosition == null)];
  }

  Future<Restaurant?> restaurant(String slug) async {
    final row = await _db
        .from('restaurants')
        .select('$_cols, $_menu')
        .eq('slug', slug)
        .eq('approved', true)
        .maybeSingle();
    if (row == null) return null;
    final top = await _topSellers('${row['id']}');
    return Restaurant.fromRow(row, topSellers: top);
  }

  /// Ranked by units sold when there's enough history; null = fall back to
  /// the hand-picked flags.
  Future<Set<String>?> _topSellers(String restaurantId) async {
    try {
      final rows = await _db.rpc('menu_item_popularity', params: {
        'p_restaurant_id': restaurantId,
        'p_days': _popularityDays,
      }) as List;
      final units = <String, num>{
        for (final r in rows)
          if ((r['units'] as num? ?? 0) > 0) '${r['menu_item_id']}': r['units'] as num,
      };
      if (units.length < _minRanked) return null;
      final sorted = units.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
      return sorted.take(_popularLimit).map((e) => e.key).toSet();
    } catch (_) {
      return null;
    }
  }

  Future<PlatformSettings> settings() async {
    final row = await _db
        .from('platform_settings')
        .select(PlatformSettings.columns)
        .eq('id', true)
        .maybeSingle();
    return row == null ? PlatformSettings.defaults : PlatformSettings.fromRow(row);
  }

  /// RLS only returns live, in-window campaigns.
  Future<List<PromoBanner>> banners(String placement) async {
    final rows = await _db
        .from('banners')
        .select(PromoBanner.columns)
        .contains('placements', [placement])
        .order('priority', ascending: false)
        .order('display_order');
    return [for (final r in rows) PromoBanner.fromRow(r)];
  }

  /// Operator replacements for the category tile photos (migration 0037).
  Future<Map<String, String>> categoryImages() async {
    try {
      final rows = await _db.from('category_images').select('id, image_url');
      return {
        for (final r in rows)
          if (r['image_url'] != null) '${r['id']}': '${r['image_url']}',
      };
    } catch (_) {
      return const {};
    }
  }
}
