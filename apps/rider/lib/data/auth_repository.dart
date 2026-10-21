import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';

enum SignInFailure { invalidCredentials, network, rateLimited, other }

/// An email sign-in that did not work, sorted into what the screen can say.
class SignInException implements Exception {
  const SignInException(this.kind);
  final SignInFailure kind;

  @override
  String toString() => 'SignInException($kind)';
}

/// Phone-OTP (the website's custom flow over Renflair SMS) and email +
/// password (Supabase directly, as the web operator login does).
class AuthRepository {
  AuthRepository(this._db, this._api);

  final SupabaseClient _db;
  final ApiClient _api;

  /// `{devMode, devCode?}`: devCode only outside production.
  Future<({bool devMode, String? devCode})> requestOtp(String phone) async {
    final res = await _api.post('/api/auth/otp/request', {'phone': phone});
    return (devMode: res['devMode'] == true, devCode: res['devCode'] as String?);
  }

  /// Verifies the code, then exchanges the magic-link hash for a session.
  /// Throws [ApiException] for a wrong, expired or locked code.
  Future<void> verifyOtp(String phone, String code) async {
    final res = await _api.post('/api/auth/otp/verify', {'phone': phone, 'code': code});
    await _db.auth.verifyOTP(type: OtpType.email, tokenHash: '${res['tokenHash']}');
  }

  /// Rider accounts are created with an email and a one-time password in
  /// Admin → Settings → Employees. Throws [SignInException].
  Future<void> signInWithEmail(String email, String password) async {
    try {
      await _db.auth.signInWithPassword(email: email.trim(), password: password);
    } on AuthException catch (e) {
      throw SignInException(_kind(e));
    } catch (_) {
      // Socket errors and timeouts arrive as non-Auth exceptions.
      throw const SignInException(SignInFailure.network);
    }
  }

  SignInFailure _kind(AuthException e) {
    if (e is AuthRetryableFetchException) return SignInFailure.network;
    if (e.code == 'invalid_credentials' ||
        e.message.toLowerCase().contains('invalid login credentials')) {
      return SignInFailure.invalidCredentials;
    }
    if (e.statusCode == '429' || e.code == 'over_request_rate_limit') {
      return SignInFailure.rateLimited;
    }
    return SignInFailure.other;
  }

  /// Ends the session. [everywhere] also revokes this account's other
  /// sessions (`SignOutScope.global`). The local session is cleared before the
  /// server is told, so an unreachable server cannot keep the rider signed in.
  Future<void> signOut({bool everywhere = false}) async {
    try {
      await _db.auth.signOut(scope: everywhere ? SignOutScope.global : SignOutScope.local);
    } catch (_) {
      // Local state is already gone; the server-side revoke is best effort.
    }
  }
}
