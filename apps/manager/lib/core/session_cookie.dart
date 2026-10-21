import 'dart:convert';

/// The website's API routes authenticate with the `@supabase/ssr` session
/// cookie only — they never read an `Authorization` header. So the app sends
/// the same cookie the browser would, built from the session the Supabase SDK
/// already holds. Every detail here mirrors `@supabase/ssr` (cookieEncoding
/// "base64url", utils/chunker.js); change one side and the server stops
/// recognising the session.

/// `@supabase/ssr` MAX_CHUNK_SIZE.
const maxCookieChunk = 3180;

/// `sb-<project-ref>-auth-token`, the supabase-js default storage key.
String sessionCookieName(String supabaseUrl) {
  final ref = Uri.parse(supabaseUrl).host.split('.').first;
  return 'sb-$ref-auth-token';
}

/// `base64-` + unpadded base64url(UTF-8 JSON).
String sessionCookieValue(Map<String, dynamic> session) {
  final encoded = base64Url.encode(utf8.encode(jsonEncode(session)));
  return 'base64-${encoded.replaceAll('=', '')}';
}

/// Splits like `createChunks`. The value is pure base64url ASCII, which
/// `encodeURIComponent` leaves untouched, so a plain slice is exact.
List<MapEntry<String, String>> chunkCookie(String name, String value) {
  if (value.length <= maxCookieChunk) return [MapEntry(name, value)];
  final chunks = <MapEntry<String, String>>[];
  for (var i = 0, n = 0; i < value.length; i += maxCookieChunk, n++) {
    final end = (i + maxCookieChunk).clamp(0, value.length);
    chunks.add(MapEntry('$name.$n', value.substring(i, end)));
  }
  return chunks;
}

String cookieHeader(List<MapEntry<String, String>> cookies) =>
    cookies.map((c) => '${c.key}=${c.value}').join('; ');
