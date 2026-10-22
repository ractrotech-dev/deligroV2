import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show MediaType;
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

  /// The server answered, but it is not a server that has the rider routes
  /// (404) or it has no backend configured (`not_configured`). The only
  /// answers that mean "this app needs a newer server".
  bool get serverUnsupported => status == 404 || code == 'not_configured';

  /// No usable answer, which says nothing about the rider: no connection
  /// (status 0), or any 5xx, including the edge's non-JSON ones (`http_503`).
  /// For a rider whose data already loaded it is a blip, not a verdict.
  bool get transient => !serverUnsupported && (status == 0 || status >= 500);

  /// What to show the rider.
  String get friendly => message ?? friendlyError(code);

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
class ApiClient {
  ApiClient(this._auth, {http.Client? client}) : _http = client ?? http.Client();

  final GoTrueClient _auth;
  final http.Client _http;
  final _cookieName = sessionCookieName(Env.supabaseUrl);

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('${Env.siteUrl}$path').replace(queryParameters: query);

  Future<Map<String, String>> _headers({bool json = true}) async {
    final headers = <String, String>{
      'accept': 'application/json',
      if (json) 'content-type': 'application/json',
      'x-client': 'deligro-rider-flutter/${Env.versionCode}',
    };
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
      final cookies = chunkCookie(
        _cookieName,
        sessionCookieValue(session!.toJson()),
      );
      headers['cookie'] = cookieHeader(cookies);
    }
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

  /// A multipart POST with one file under [field]. The type is sent because
  /// the proof route reads it (`image/jpeg` or `image/png`) before it looks at
  /// the bytes. A photo is up to 5 MB, so it gets longer than a JSON call.
  Future<Map<String, dynamic>> upload(
    String path,
    String field,
    File file, {
    required MediaType contentType,
    Duration timeout = const Duration(seconds: 60),
    Map<String, String> fields = const {},
  }) async =>
      _send(timeout: timeout, () async {
        final request = http.MultipartRequest('POST', _uri(path))
          ..headers.addAll(await _headers(json: false))
          ..fields.addAll(fields)
          ..files.add(await http.MultipartFile.fromPath(field, file.path, contentType: contentType));
        return http.Response.fromStream(await _http.send(request));
      });

  /// Like [upload], for a file that exists only in memory (a photo the app
  /// shrank): the bytes go straight into the request and are never written to
  /// the phone.
  Future<Map<String, dynamic>> uploadBytes(
    String path,
    String field,
    List<int> bytes, {
    required String filename,
    required MediaType contentType,
    Duration timeout = const Duration(seconds: 60),
    Map<String, String> fields = const {},
  }) async =>
      _send(timeout: timeout, () async {
        final request = http.MultipartRequest('POST', _uri(path))
          ..headers.addAll(await _headers(json: false))
          ..fields.addAll(fields)
          ..files.add(http.MultipartFile.fromBytes(field, bytes, filename: filename, contentType: contentType));
        return http.Response.fromStream(await _http.send(request));
      });

  Future<Map<String, dynamic>> _send(
    Future<http.Response> Function() call, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final http.Response res;
    try {
      res = await call().timeout(timeout);
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
