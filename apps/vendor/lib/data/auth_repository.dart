import 'package:supabase_flutter/supabase_flutter.dart';

import '../core/api.dart';

/// The three ways into the Partner app: phone OTP, mobile + password (the
/// login an admin hands a vendor at onboarding), and email + password.
class AuthRepository {
  AuthRepository(this._auth, this._api);

  final GoTrueClient _auth;
  final ApiClient _api;

  static final _mobile = RegExp(r'^[6-9]\d{9}$');

  /// `devCode` is set only when the server is in SMS test mode.
  Future<({bool devMode, String? devCode})> requestOtp(String phone) async {
    final res = await _api.post('/api/auth/otp/request', {'phone': phone});
    return (devMode: res['devMode'] == true, devCode: res['devCode'] as String?);
  }

  /// The same two steps as the website: the route checks the code and returns
  /// a token hash, which the SDK exchanges for a session.
  Future<void> verifyOtp(String phone, String code) async {
    final res = await _api.post('/api/auth/otp/verify', {'phone': phone, 'code': code});
    await _auth.verifyOTP(type: OtpType.email, tokenHash: '${res['tokenHash']}');
  }

  /// [login] is a 10-digit mobile number or an email address.
  Future<void> passwordLogin(String login, String password) async {
    final id = login.trim();
    if (id.contains('@')) {
      try {
        await _auth.signInWithPassword(email: id, password: password);
      } on AuthException {
        throw ApiException(401, 'bad_credentials');
      }
      return;
    }
    final digits = id.replaceAll(RegExp(r'\D'), '');
    final local = digits.length == 12 && digits.startsWith('91') ? digits.substring(2) : digits;
    if (!_mobile.hasMatch(local)) throw ApiException(400, 'invalid_phone');
    final res = await _api.post('/api/auth/password-login', {'mobile': local, 'password': password});
    await _auth.setSession('${res['refreshToken']}');
  }

  Future<void> signOut() => _auth.signOut();
}
