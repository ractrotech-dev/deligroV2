import 'package:supabase_flutter/supabase_flutter.dart';

import '../config/env.dart';
import '../core/api.dart';
import '../models/address.dart';
import '../models/restaurant.dart';

class Profile {
  const Profile({
    required this.id,
    required this.fullName,
    required this.phone,
    required this.avatarUrl,
    required this.role,
    required this.createdAt,
  });
  final String id;
  final String? fullName;
  final String? phone;
  final String? avatarUrl;
  final String role;
  final DateTime? createdAt;

  /// Only these roles may insert orders (migration 0040).
  bool get canOrder => role == 'customer' || role == 'admin';
}

/// OTP sign-in, profile, saved addresses and favourites.
class AccountRepository {
  AccountRepository(this._db, this._api);
  final SupabaseClient _db;
  final ApiClient _api;

  // ---------- Sign-in (custom OTP over Renflair SMS) ----------

  /// `{sent, devMode, devCode?}` — devCode only outside production.
  Future<({bool devMode, String? devCode})> requestOtp(String phone) async {
    final res = await _api.post('/api/auth/otp/request', {'phone': phone});
    return (devMode: res['devMode'] == true, devCode: res['devCode'] as String?);
  }

  /// Verifies the code, then exchanges the magic-link hash for a session —
  /// the same two steps as src/components/auth/otp-login.tsx.
  Future<bool> verifyOtp(String phone, String code) async {
    final res = await _api.post('/api/auth/otp/verify', {'phone': phone, 'code': code});
    await _db.auth.verifyOTP(type: OtpType.email, tokenHash: '${res['tokenHash']}');
    return res['isNewUser'] == true;
  }

  /// Unbinds this phone's push subscription from the account first, so the
  /// next person on the phone does not get this account's order updates.
  /// Best effort: a failed call never keeps anyone signed in.
  Future<void> signOut() async {
    try {
      await _api.delete('/api/notifications/register');
    } catch (_) {}
    await _db.auth.signOut();
  }

  /// Ties OneSignal's subscription to this account for order pushes.
  Future<void> registerPush(String playerId) =>
      _api.post('/api/notifications/register', {'playerId': playerId});

  // ---------- Profile ----------

  Future<Profile?> profile() async {
    final uid = _db.auth.currentUser?.id;
    if (uid == null) return null;
    final r = await _db
        .from('profiles')
        .select('id, full_name, phone, avatar_url, role, created_at')
        .eq('id', uid)
        .maybeSingle();
    if (r == null) return null;
    return Profile(
      id: '${r['id']}',
      fullName: r['full_name'] as String?,
      phone: r['phone'] as String?,
      avatarUrl: r['avatar_url'] as String?,
      role: '${r['role'] ?? 'customer'}',
      createdAt: DateTime.tryParse('${r['created_at']}'),
    );
  }

  Future<void> updateName(String fullName) =>
      _api.patch('/api/profile', {'fullName': fullName});

  /// Ask for an OTP on the new number with [requestOtp] first.
  Future<void> updatePhone(String phone, String otp) =>
      _api.patch('/api/profile', {'phone': phone, 'phoneOtp': otp});

  // ---------- Addresses ----------

  Future<List<SavedAddress>> addresses() async {
    final res = await _api.get('/api/addresses');
    return [
      for (final a in (res['addresses'] as List? ?? const []))
        SavedAddress.fromApi(Map<String, dynamic>.from(a as Map)),
    ];
  }

  Future<SavedAddress> addAddress({
    required String label,
    required String line,
    double? lat,
    double? lng,
    bool isDefault = false,
  }) async {
    final res = await _api.post('/api/addresses', {
      'label': label,
      'line': line,
      'lat': lat,
      'lng': lng,
      'isDefault': isDefault,
    });
    return SavedAddress.fromApi(Map<String, dynamic>.from(res['address'] as Map));
  }

  Future<void> updateAddress(String id, Map<String, Object?> fields) =>
      _api.patch('/api/addresses/$id', fields);

  Future<void> deleteAddress(String id) => _api.delete('/api/addresses/$id');

  // ---------- Favourites ----------

  Future<bool> isFavorite(String restaurantId) async {
    if (_db.auth.currentUser == null) return false;
    final row = await _db
        .from('favorites')
        .select('restaurant_id')
        .eq('restaurant_id', restaurantId)
        .maybeSingle();
    return row != null;
  }

  Future<bool> setFavorite(String slug, bool on) async {
    final res = on
        ? await _api.post('/api/favorites', {'slug': slug})
        : await _api.delete('/api/favorites', {'slug': slug});
    return res['favorite'] == true;
  }

  Future<List<Restaurant>> favorites() async {
    if (_db.auth.currentUser == null) return const [];
    final rows = await _db.from('favorites').select(
          'restaurants(id, slug, name, tagline, is_open, image_url, accent_tint, '
          'cuisines, rating, rating_count, eta_min, eta_max, price_tier, '
          'cost_for_two, lat, lng, address, busy_until, busy_extra_minutes, '
          'offer_expires_at, offer, promoted)',
        );
    return [
      for (final r in rows)
        if (r['restaurants'] != null)
          Restaurant.fromRow(Map<String, dynamic>.from(r['restaurants'] as Map)),
    ];
  }

  // ---------- App updates ----------

  Future<({bool updateAvailable, bool forceUpdate, String apkUrl, String notes})?>
      appVersion() async {
    try {
      final res = await _api.get(
        '/api/app-version',
        query: {'app': 'customer', 'versionCode': '${Env.versionCode}'},
      );
      return (
        updateAvailable: res['updateAvailable'] == true,
        forceUpdate: res['forceUpdate'] == true,
        apkUrl: '${res['apkUrl'] ?? ''}',
        notes: '${res['releaseNotes'] ?? ''}',
      );
    } catch (_) {
      return null;
    }
  }
}
