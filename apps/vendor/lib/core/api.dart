import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';

import '../config/env.dart';
import 'errors.dart';
import 'session_cookie.dart';

class ApiException implements Exception {
  ApiException(this.status, this.code, {this.message, this.body = const {}});

  final int status;

  /// The route's machine code (`invalid_phone`, `coupon_expired`, …).
  final String code;

  /// A server-written sentence, when the route sends one.
  final String? message;
  final Map<String, dynamic> body;

  bool get unauthorized => status == 401;

  /// What to show the vendor, in English or Hindi.
  String friendly({bool hi = false}) => message ?? friendlyError(code, hi: hi);

  @override
  String toString() => 'ApiException($status, $code)';
}

/// Talks to the website's `/api/*` routes.
///
/// Those routes read the Supabase session from the `@supabase/ssr` cookie and
/// ignore `Authorization`, so authenticated calls carry that cookie (see
/// session_cookie.dart). The access token is refreshed here *before* it can
/// expire: if the server ever refreshed it instead, it would rotate the refresh
/// token behind the SDK's back. Should that still happen, [_adoptRotated]
/// takes the server's new session so the app is not signed out.
///
/// Vendor routes resolve the shop on the server; an owner of several shops
/// picks one with the website's `vendor_restaurant_slug` cookie, which
/// [shopSlug] supplies. The server still checks the shop is theirs.
class ApiClient {
  ApiClient(this._auth, {http.Client? client, this.shopSlug})
      : _http = client ?? http.Client();

  final GoTrueClient _auth;
  final http.Client _http;
  final String? Function()? shopSlug;
  final _cookieName = sessionCookieName(Env.supabaseUrl);

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('${Env.siteUrl}$path').replace(queryParameters: query);

  Future<Map<String, String>> _headers({bool json = true}) async {
    final headers = <String, String>{
      'accept': 'application/json',
      if (json) 'content-type': 'application/json',
      'x-client': 'deligro-partner-flutter/${Env.versionCode}',
    };
    final cookies = <String>[];
    var session = _auth.currentSession;
    if (session != null) {
      final expiresAt = session.expiresAt;
      final soon = DateTime.now()
          .add(const Duration(seconds: 90))
          .millisecondsSinceEpoch ~/ 1000;
      if (expiresAt == null || expiresAt <= soon) {
        try {
          session = (await _auth.refreshSession()).session ?? session;
        } catch (_) {
          // Fall through with what we have; the route answers 401 if stale.
        }
      }
      cookies.add(cookieHeader(chunkCookie(
        _cookieName,
        sessionCookieValue(session!.toJson()),
      )));
    }
    final slug = shopSlug?.call();
    if (slug != null && slug.isNotEmpty) {
      cookies.add('vendor_restaurant_slug=${Uri.encodeComponent(slug)}');
    }
    if (cookies.isNotEmpty) headers['cookie'] = cookies.join('; ');
    return headers;
  }

  Future<Map<String, dynamic>> get(String path, {Map<String, String>? query}) async =>
      _send(() async => _http.get(_uri(path, query), headers: await _headers(json: false)));

  Future<Map<String, dynamic>> post(String path, [Object? body]) async => _send(
        () async => _http.post(
          _uri(path),
          headers: await _headers(),
          body: jsonEncode(body ?? const {}),
        ),
      );

  Future<Map<String, dynamic>> patch(String path, Object body) async => _send(
        () async => _http.patch(
          _uri(path),
          headers: await _headers(),
          body: jsonEncode(body),
        ),
      );

  Future<Map<String, dynamic>> delete(String path, [Object? body]) async => _send(
        () async => _http.delete(
          _uri(path),
          headers: await _headers(),
          body: body == null ? null : jsonEncode(body),
        ),
      );

  Future<Map<String, dynamic>> _send(Future<http.Response> Function() call) async {
    final http.Response res;
    try {
      res = await call().timeout(const Duration(seconds: 20));
    } catch (_) {
      throw ApiException(0, 'network');
    }
    await _adoptRotated(res.headers['set-cookie']);

    Map<String, dynamic> body = const {};
    if (res.body.isNotEmpty) {
      try {
        final decoded = jsonDecode(res.body);
        if (decoded is Map<String, dynamic>) body = decoded;
      } catch (_) {
        // A non-JSON body (an HTML error page from the edge) — keep the status.
      }
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return body;
    throw ApiException(
      res.statusCode,
      '${body['error'] ?? 'http_${res.statusCode}'}',
      message: body['message'] as String?,
      body: body,
    );
  }

  /// If the server refreshed the session (it rotates the refresh token and
  /// says so via Set-Cookie), hand that session to the SDK.
  Future<void> _adoptRotated(String? setCookie) async {
    if (setCookie == null || !setCookie.contains(_cookieName)) return;
    final pattern = RegExp('${RegExp.escape(_cookieName)}(?:\\.(\\d+))?=([^;,]*)');
    final parts = <int, String>{};
    for (final m in pattern.allMatches(setCookie)) {
      parts[int.tryParse(m.group(1) ?? '') ?? -1] = m.group(2) ?? '';
    }
    final value = parts.containsKey(-1)
        ? parts[-1]!
        : ([...parts.keys]..sort()).map((k) => parts[k]!).join();
    if (!value.startsWith('base64-') || value.length < 20) return;
    try {
      final json = utf8.decode(base64Url.decode(base64Url.normalize(value.substring(7))));
      final current = _auth.currentSession;
      final next = jsonDecode(json) as Map<String, dynamic>;
      if (current != null && next['refresh_token'] != current.refreshToken) {
        await _auth.recoverSession(json);
      }
    } catch (_) {
      // Best effort; a broken cookie must never crash a request.
    }
  }
}
