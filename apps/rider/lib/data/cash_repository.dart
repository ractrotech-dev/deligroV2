import 'dart:io';

import 'package:http_parser/http_parser.dart' show MediaType;

import '../core/api.dart';
import '../core/receipt_photo.dart';
import '../models/cash.dart';

/// The rider's cash: `/api/rider/cash/*`. [ApiCashRepository] talks to the
/// website; a debug build can swap in the fixture backend
/// (data/fixtures/fixture_cash.dart).
///
/// Every method throws [ApiException]: 429, 503 `migration_pending` or a dead
/// connection, and for the writes the codes noted below. Cash collected for
/// Deligro is never part of the rider's earnings.
abstract interface class CashRepository {
  /// `GET /api/rider/cash/summary`.
  Future<CashSummary> summary();

  /// `GET /api/rider/cash/collections` for the IST days [from]..[to], newest
  /// first. Cash and paid-online orders together.
  Future<CollectionsPage> collections({
    required String from,
    required String to,
    String? cursor,
    int limit = 50,
  });

  /// `GET /api/rider/cash/deposits`, newest first.
  Future<List<CashDeposit>> deposits();

  /// `GET /api/rider/cash/managers`.
  Future<List<CashManager>> managers();

  /// `POST /api/rider/cash/deposits`; returns the new deposit's id. 400
  /// `invalid_amount`, `reference_required` (UPI), `bad_photo`,
  /// `invalid_manager`, `invalid_note`; 409 `exceeds_pending` (body
  /// `pending`, `available`).
  Future<String> submitDeposit({
    required int amount,
    required bool upi,
    String? managerId,
    String? reference,
    String? note,
    File? photo,
  });

  /// `DELETE /api/rider/cash/deposits/:id`: withdraw one still waiting. 404
  /// `not_found`, 409 `already_decided`.
  Future<void> withdrawDeposit(String id);

  /// `GET /api/rider/cash/disputes`, newest first.
  Future<List<CashDispute>> disputes();

  /// `POST /api/rider/cash/disputes`: this [day]'s figure is wrong. 400
  /// `invalid_day`, `message_required`, `invalid_amount`; 409 `already_open`.
  Future<String> raiseDispute({
    required String day,
    required String message,
    int? claimedAmount,
  });
}

class ApiCashRepository implements CashRepository {
  ApiCashRepository(this._api);

  final ApiClient _api;

  Future<T> _read<T>(
    Future<Map<String, dynamic>> call,
    T Function(Map<String, dynamic> j) parse,
  ) async {
    final res = await call;
    try {
      return parse(res);
    } on FormatException {
      throw ApiException(500, 'bad_response');
    } on TypeError {
      throw ApiException(500, 'bad_response');
    }
  }

  List<T> _list<T>(
    Map<String, dynamic> j,
    T Function(Map<String, dynamic>) parse,
  ) => [
    for (final e in (j['items'] as List? ?? const []))
      if (e is Map) parse(Map<String, dynamic>.from(e)),
  ];

  String _id(Map<String, dynamic> res) {
    final id = res['id'];
    if (id is! String || id.isEmpty) throw ApiException(500, 'bad_response');
    return id;
  }

  @override
  Future<CashSummary> summary() =>
      _read(_api.get('/api/rider/cash/summary'), CashSummary.fromJson);

  @override
  Future<CollectionsPage> collections({
    required String from,
    required String to,
    String? cursor,
    int limit = 50,
  }) => _read(
    _api.get(
      '/api/rider/cash/collections',
      query: {'from': from, 'to': to, 'limit': '$limit', 'cursor': ?cursor},
    ),
    CollectionsPage.fromJson,
  );

  @override
  Future<List<CashDeposit>> deposits() => _read(
    _api.get('/api/rider/cash/deposits'),
    (j) => _list(j, CashDeposit.fromJson),
  );

  @override
  Future<List<CashManager>> managers() => _read(
    _api.get('/api/rider/cash/managers'),
    (j) => _list(j, CashManager.fromJson),
  );

  @override
  Future<String> submitDeposit({
    required int amount,
    required bool upi,
    String? managerId,
    String? reference,
    String? note,
    File? photo,
  }) async {
    // The type comes from the bytes, never the file name; anything that is not
    // a JPEG or PNG within the size limit is refused here, before sending.
    MediaType? type;
    if (photo != null) {
      type = receiptTypeOf(photo);
      if (type == null) throw ApiException(400, 'bad_photo');
    }
    final method = upi ? 'upi' : 'cash';
    final fields = <String, String>{
      if (managerId != null && managerId.isNotEmpty) 'managerId': managerId,
      if (upi && reference != null && reference.trim().isNotEmpty) 'reference': reference.trim(),
      if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
    };
    // No photo: the route takes the same fields as JSON. With one, the photo
    // goes as multipart through the shared upload path.
    final Map<String, dynamic> res;
    if (photo == null || type == null) {
      res = await _api.post('/api/rider/cash/deposits', {'amount': amount, 'method': method, ...fields});
    } else {
      res = await _api.uploadBytes(
        '/api/rider/cash/deposits',
        'photo',
        await photo.readAsBytes(),
        filename: 'receipt.${type.subtype == 'png' ? 'png' : 'jpg'}',
        contentType: type,
        fields: {'amount': '$amount', 'method': method, ...fields},
      );
    }
    return _id(res);
  }

  @override
  Future<void> withdrawDeposit(String id) async {
    await _api.delete('/api/rider/cash/deposits/$id');
  }

  @override
  Future<List<CashDispute>> disputes() => _read(
    _api.get('/api/rider/cash/disputes'),
    (j) => _list(j, CashDispute.fromJson),
  );

  @override
  Future<String> raiseDispute({
    required String day,
    required String message,
    int? claimedAmount,
  }) async {
    final res = await _api.post('/api/rider/cash/disputes', {
      'day': day,
      'message': message.trim(),
      'claimedAmount': ?claimedAmount,
    });
    return _id(res);
  }
}
