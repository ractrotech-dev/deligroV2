import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';

/// The three ways into the Manager app: mobile + password (the login an admin
/// creates on Team), phone OTP, and email + password.
class AuthRepository {
  AuthRepository(this._auth, this._api);

  final GoTrueClient _auth;
  final ApiClient _api;

  static final _mobile = RegExp(r'^[6-9]\d{9}$');

  /// A 10-digit Indian mobile from whatever was typed (spaces, +91), or null.
  static String? normaliseMobile(String raw) {
    final digits = raw.replaceAll(RegExp(r'\D'), '');
    final local = digits.length == 12 && digits.startsWith('91') ? digits.substring(2) : digits;
    return _mobile.hasMatch(local) ? local : null;
  }

  /// `devCode` is set only when the server is in SMS test mode.
  Future<({bool devMode, String? devCode})> requestOtp(String phone) async {
    final res = await _api.post('/api/auth/otp/request', {'phone': phone});
    return (devMode: res['devMode'] == true, devCode: res['devCode'] as String?);
  }

  /// The route checks the code and returns a token hash, which the SDK
  /// exchanges for a session — the same two steps as the website.
  Future<void> verifyOtp(String phone, String code) async {
    final res = await _api.post('/api/auth/otp/verify', {'phone': phone, 'code': code});
    await _auth.verifyOTP(type: OtpType.email, tokenHash: '${res['tokenHash']}');
  }

  Future<void> passwordLogin(String mobile, String password) async {
    final local = normaliseMobile(mobile);
    if (local == null) throw ApiException(400, 'invalid_phone');
    final res = await _api.post('/api/auth/password-login', {'mobile': local, 'password': password});
    await _auth.setSession('${res['refreshToken']}');
  }

  Future<void> emailLogin(String email, String password) async {
    try {
      await _auth.signInWithPassword(email: email.trim(), password: password);
    } on AuthException {
      throw ApiException(401, 'bad_credentials');
    }
  }

  /// This device only. "Sign out everywhere" is a server call (sessions).
  Future<void> signOut() => _auth.signOut(scope: SignOutScope.local);
}
