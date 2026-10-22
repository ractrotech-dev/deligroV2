import 'package:supabase_flutter/supabase_flutter.dart';

import '../models/banner.dart';
import 'campaign_repository.dart';
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
      'offer_expires_at, offer, promoted, sort_position, opening_time';
  static const _menu =
      'menu_items(id, external_id, name, description, price, discount_price, '
      'veg, available, category, image_url, popular, bestseller)';

  /// The menu with 0062's schedule, stock, sizes and add-ons embedded.
  static const _menuFull =
      'menu_items(id, external_id, name, description, price, discount_price, '
      'veg, available, category, image_url, popular, bestseller, '
      'stock_qty, available_days, available_from, available_to, '
      'menu_item_variants(id, name, price, available, sort_order), '
      'menu_item_addon_groups(id, name, min_select, max_select, sort_order, '
      'menu_item_addons(id, name, price, available, sort_order)))';

  /// Null until asked; false once the database is known to predate 0062
  /// (PostgREST: 42703 missing column, PGRST200 unknown relationship,
  /// PGRST202 unknown function), so the app stops asking.
  static bool? _has0062;

  static bool _missingSchema(Object e) =>
      e is PostgrestException && const {'42703', 'PGRST200', 'PGRST202'}.contains(e.code);

  /// Runs [full] while 0062 may exist, else (or on its "missing" answer) [plain].
  Future<T> _with0062<T>(Future<T> Function() full, Future<T> Function() plain) async {
    if (_has0062 == false) return plain();
    try {
      final out = await full();
      _has0062 = true;
      return out;
    } catch (e) {
      if (!_missingSchema(e)) rethrow;
      _has0062 = false;
      return plain();
    }
  }

  /// restaurant_open_statuses: why each shop is or isn't taking orders now.
  /// Empty before 0062 (the app then trusts `is_open`).
  Future<Map<String, String>> _statuses(List<String> ids) async {
    if (ids.isEmpty || _has0062 == false) return const {};
    try {
      final rows = await _db.rpc('restaurant_open_statuses', params: {'p_ids': ids}) as List;
      return {for (final r in rows) '${r['restaurant_id']}': '${r['status']}'};
    } catch (e) {
      if (_missingSchema(e)) _has0062 = false;
      return const {};
    }
  }

  // Popularity rules from src/lib/popularity.ts.
  static const _popularityDays = 30;
  static const _popularLimit = 8;
  static const _minRanked = 3;

  /// Approved shops: promoted first, then by name, with admin-pinned slots
  /// floated to the top in slot order (as listRestaurantsFromDb does).
  ///
  /// Live featured-store campaigns (0160) hold their slots ahead of the pins,
  /// decided by the server from each campaign's window.
  Future<List<Restaurant>> listRestaurants({bool withMenu = false, LivePlacements placements = LivePlacements.empty}) async {
    Future<List<Map<String, dynamic>>> query(String menu) => _db
        .from('restaurants')
        .select(withMenu ? '$_cols, $menu' : _cols)
        .eq('approved', true)
        .order('promoted', ascending: false)
        .order('name');
    final rows = withMenu ? await _with0062(() => query(_menuFull), () => query(_menu)) : await query(_menu);
    final statuses = await _statuses([for (final r in rows) '${r['id']}']);
    final list = [for (final r in rows) Restaurant.fromRow(r, status: statuses['${r['id']}'])];
    final positions = effectivePositions(
      {for (final r in list) if (r.sortPosition != null) r.id: r.sortPosition!},
      {for (final e in placements.featured.entries) e.key: e.value.slot},
    );
    final pinned = list.where((r) => positions.containsKey(r.id)).toList()
      ..sort((a, b) => positions[a.id]!.compareTo(positions[b.id]!));
    return [...pinned, ...list.where((r) => !positions.containsKey(r.id))];
  }

  Future<Restaurant?> restaurant(String slug) async {
    Future<Map<String, dynamic>?> query(String menu) =>
        _db.from('restaurants').select('$_cols, $menu').eq('slug', slug).eq('approved', true).maybeSingle();
    final row = await _with0062(() => query(_menuFull), () => query(_menu));
    if (row == null) return null;
    final id = '${row['id']}';
    final (top, statuses) = await (_topSellers(id), _statuses([id])).wait;
    return Restaurant.fromRow(row, topSellers: top, status: statuses[id]);
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
