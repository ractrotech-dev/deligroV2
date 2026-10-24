import 'dart:convert';
import 'dart:typed_data';

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

  /// What to show the manager.
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
      'x-client': Env.clientId,
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

  Future<Map<String, dynamic>> put(String path, Object body) async => _send(
        () async => _http.put(
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

  /// A file the server generates (a sheet to download), as bytes.
  Future<Uint8List> getBytes(String path, {Map<String, String>? query}) async {
    final http.Response res;
    try {
      res = await _http.get(_uri(path, query), headers: await _headers(json: false)).timeout(const Duration(seconds: 60));
    } catch (_) {
      throw ApiException(0, 'network');
    }
    await _adoptRotated(res.headers['set-cookie']);
    if (res.statusCode == 200) return res.bodyBytes;
    var code = 'http_${res.statusCode}';
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic> && decoded['error'] is String) code = decoded['error'] as String;
    } catch (_) {
      // Not JSON: keep the status.
    }
    throw ApiException(res.statusCode, code);
  }

  /// A multipart upload (document files). Longer timeout: a 10 MB PDF on a
  /// slow connection takes a while.
  Future<Map<String, dynamic>> postMultipart(
    String path, {
    required Map<String, String> fields,
    required String fileField,
    required List<int> bytes,
    required String fileName,
  }) async =>
      _send(
        () async {
          final req = http.MultipartRequest('POST', _uri(path))
            ..headers.addAll(await _headers(json: false))
            ..fields.addAll(fields)
            ..files.add(http.MultipartFile.fromBytes(fileField, bytes, filename: fileName));
          return http.Response.fromStream(await _http.send(req));
        },
        timeout: const Duration(seconds: 90),
      );

  /// A multipart post with several files under one field (`files[]` on a
  /// ticket reply), plus plain fields.
  Future<Map<String, dynamic>> postMultipartFiles(
    String path, {
    required Map<String, String> fields,
    required String fileField,
    required List<({List<int> bytes, String name})> files,
  }) async =>
      _send(
        () async {
          final req = http.MultipartRequest('POST', _uri(path))
            ..headers.addAll(await _headers(json: false))
            ..fields.addAll(fields);
          for (final f in files) {
            req.files.add(http.MultipartFile.fromBytes(fileField, f.bytes, filename: f.name));
          }
          return http.Response.fromStream(await _http.send(req));
        },
        timeout: const Duration(seconds: 90),
      );

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
