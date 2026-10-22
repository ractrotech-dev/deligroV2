import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart' show MediaType;

import '../core/api.dart';
import '../core/document_file.dart';
import '../models/profile.dart';

/// Whether a change request is waiting for Deligro or was saved straight away
/// (the rider is not verified yet).
enum ChangeOutcome { pending, applied }

/// The rider's profile and documents: `/api/rider/profile*`,
/// `/api/rider/documents*`, plus the avatar and phone-change routes that
/// already exist. [ApiProfileRepository] talks to the website; a debug build
/// can swap in the fixture backend (data/fixtures/fixture_profile.dart).
///
/// Every method throws [ApiException]: 403 `feature_disabled` (profile editing
/// is off for this rider; reads still work), 400 `invalid_value` (with the
/// offending `field` in [ApiException.body]), 409 `duplicate_pending` or
/// `needs_approval`, 429, 503 `migration_pending`, or a dead connection.
abstract interface class ProfileRepository {
  /// `GET /api/rider/profile`.
  Future<RiderProfile> profile();

  /// `GET /api/rider/profile/change-requests`, newest first.
  Future<List<ChangeRequestView>> changeRequests();

  /// `PATCH /api/rider/profile`: the fields that save directly. A sub-field
  /// left out keeps its value; `null` clears it.
  Future<void> saveDirect({Map<String, Object?>? address, Map<String, Object?>? emergency});

  /// `POST /api/rider/profile/change-requests` for [field] (`full_name`,
  /// `licence`, `vehicle`, `payout_account`) with its `value` object.
  Future<ChangeOutcome> requestChange(String field, Map<String, Object?> value);

  /// `POST /api/rider/documents` (multipart): uploads or replaces one document.
  Future<void> uploadDocument({
    required String type,
    String? number,
    String? expiresOn,
    required PickedDocument file,
  });

  /// The document's bytes, through its 10-minute signed link
  /// (`GET /api/rider/documents/:id/url`, then the link). Memory only.
  Future<DocumentContent> openDocument(String id);

  /// `POST /api/profile/avatar`.
  Future<void> uploadAvatar(File photo);

  /// Asks for a code on the NEW number (`/api/auth/otp/request`).
  Future<void> sendPhoneCode(String phone);

  /// `PATCH /api/profile { phone, phoneOtp }`.
  Future<void> updatePhone(String phone, String code);
}

class ApiProfileRepository implements ProfileRepository {
  ApiProfileRepository(this._api, {http.Client? downloader}) : _download = downloader ?? http.Client();

  final ApiClient _api;
  final http.Client _download;

  Future<T> _read<T>(Future<Map<String, dynamic>> call, T Function(Map<String, dynamic> j) parse) async {
    final res = await call;
    try {
      return parse(res);
    } on FormatException {
      throw ApiException(500, 'bad_response');
    } on TypeError {
      throw ApiException(500, 'bad_response');
    }
  }

  @override
  Future<RiderProfile> profile() => _read(
    _api.get('/api/rider/profile'),
    (j) => RiderProfile.fromJson(Map<String, dynamic>.from(j['profile'] as Map)),
  );

  @override
  Future<List<ChangeRequestView>> changeRequests() => _read(
    _api.get('/api/rider/profile/change-requests'),
    (j) => [
      for (final c in (j['changeRequests'] as List? ?? const []))
        if (c is Map) ChangeRequestView.fromJson(Map<String, dynamic>.from(c)),
    ],
  );

  @override
  Future<void> saveDirect({Map<String, Object?>? address, Map<String, Object?>? emergency}) async {
    await _api.patch('/api/rider/profile', {'address': ?address, 'emergency': ?emergency});
  }

  @override
  Future<ChangeOutcome> requestChange(String field, Map<String, Object?> value) async {
    final res = await _api.post('/api/rider/profile/change-requests', {'field': field, 'value': value});
    return res['status'] == 'applied' ? ChangeOutcome.applied : ChangeOutcome.pending;
  }

  @override
  Future<void> uploadDocument({
    required String type,
    String? number,
    String? expiresOn,
    required PickedDocument file,
  }) async {
    final mime = file.mime;
    if (mime == null) throw ApiException(400, 'bad_type');
    final fields = {
      'type': type,
      if (number != null && number.isNotEmpty) 'number': number,
      if (expiresOn != null && expiresOn.isNotEmpty) 'expiresOn': expiresOn,
    };
    final bytes = file.bytes;
    if (bytes != null) {
      await _api.uploadBytes(
        '/api/rider/documents',
        'file',
        bytes,
        filename: file.name,
        contentType: MediaType.parse(mime),
        timeout: const Duration(seconds: 120),
        fields: fields,
      );
      return;
    }
    await _api.upload(
      '/api/rider/documents',
      'file',
      File(file.path),
      contentType: MediaType.parse(mime),
      timeout: const Duration(seconds: 120),
      fields: fields,
    );
  }

  @override
  Future<DocumentContent> openDocument(String id) async {
    final res = await _api.get('/api/rider/documents/${Uri.encodeComponent(id)}/url');
    final url = res['url'];
    if (url is! String || url.isEmpty) throw ApiException(502, 'server_error');
    final http.Response file;
    try {
      // The link carries its own signature: no session cookie goes with it.
      file = await _download.get(Uri.parse(url)).timeout(const Duration(seconds: 45));
    } catch (_) {
      throw ApiException(0, 'network');
    }
    if (file.statusCode != 200) throw ApiException(file.statusCode >= 500 ? 502 : 404, 'not_found');
    if (file.bodyBytes.length > documentMaxBytes + 1024) throw ApiException(502, 'too_large');
    return DocumentContent(bytes: file.bodyBytes, isPdf: sniffDocumentMime(file.bodyBytes) == 'application/pdf');
  }

  @override
  Future<void> uploadAvatar(File photo) async {
    // The type comes from the bytes, not the name (a camera copy can end in anything).
    final type = sniffDocumentMime(await readHead(photo.path)) == 'image/png' ? 'image/png' : 'image/jpeg';
    await _api.upload('/api/profile/avatar', 'file', photo, contentType: MediaType.parse(type));
  }

  @override
  Future<void> sendPhoneCode(String phone) async {
    await _api.post('/api/auth/otp/request', {'phone': phone});
  }

  @override
  Future<void> updatePhone(String phone, String code) async {
    await _api.patch('/api/profile', {'phone': phone, 'phoneOtp': code});
  }
}
