import 'dart:io';

import '../core/api.dart';
import '../models/support.dart';

/// The Help desk: `/api/rider/support/*`. [ApiSupportRepository] talks to the
/// website; a debug build can swap in the fixture backend
/// (data/fixtures/fixture_support.dart).
///
/// Every method throws [ApiException]: 400 (`invalid_message`,
/// `too_many_photos`, `photo_too_large`, `bad_photo_type`, `invalid_order`),
/// 404 `not_found`, 429, 503 `migration_pending` or a dead connection.
abstract interface class SupportRepository {
  /// `GET /api/rider/support/tickets`.
  Future<SupportOverview> overview();

  /// `GET /api/rider/support/tickets/:id`. 404 for a ticket that is not theirs.
  Future<TicketThread> thread(String id);

  /// `POST /api/rider/support/tickets`: JSON, or multipart with [photos].
  Future<CreatedTicket> create({
    required String category,
    String? subject,
    required String message,
    String? orderId,
    List<File> photos = const [],
    double? lat,
    double? lng,
  });

  /// `POST /api/rider/support/tickets/:id/messages`.
  Future<void> reply(String id, String message, {List<File> photos = const []});

  /// The rider's recent deliveries, for linking one to a ticket. Best effort:
  /// empty when the history route is off or unreachable.
  Future<List<RecentOrder>> recentOrders();
}

class ApiSupportRepository implements SupportRepository {
  ApiSupportRepository(this._api);

  final ApiClient _api;

  T _parse<T>(T Function() parse) {
    try {
      return parse();
    } on FormatException {
      throw ApiException(500, 'bad_response');
    } on TypeError {
      throw ApiException(500, 'bad_response');
    }
  }

  @override
  Future<SupportOverview> overview() async {
    final res = await _api.get('/api/rider/support/tickets');
    return _parse(() => SupportOverview.fromJson(res));
  }

  @override
  Future<TicketThread> thread(String id) async {
    final res = await _api.get('/api/rider/support/tickets/${Uri.encodeComponent(id)}');
    return _parse(() => TicketThread.fromJson(res));
  }

  @override
  Future<CreatedTicket> create({
    required String category,
    String? subject,
    required String message,
    String? orderId,
    List<File> photos = const [],
    double? lat,
    double? lng,
  }) async {
    final fields = <String, String>{
      'category': category,
      'message': message,
      if ((subject ?? '').trim().isNotEmpty) 'subject': subject!.trim(),
      'orderId': ?orderId,
      if (lat != null && lng != null) 'lat': '$lat',
      if (lat != null && lng != null) 'lng': '$lng',
    };
    final res = photos.isEmpty
        ? await _api.post('/api/rider/support/tickets', fields)
        : await _api.uploadMany('/api/rider/support/tickets', 'photos', photos, fields: fields);
    return _parse(() => CreatedTicket.fromJson(res));
  }

  @override
  Future<void> reply(String id, String message, {List<File> photos = const []}) async {
    final path = '/api/rider/support/tickets/${Uri.encodeComponent(id)}/messages';
    if (photos.isEmpty) {
      await _api.post(path, {'message': message});
    } else {
      await _api.uploadMany(path, 'photos', photos, fields: {'message': message});
    }
  }

  @override
  Future<List<RecentOrder>> recentOrders() async {
    try {
      final res = await _api.get('/api/rider/history');
      final orders = _parse(
        () => [
          for (final e in (res['items'] as List? ?? const []).take(20))
            if (e is Map && e['orderId'] is String)
              RecentOrder.fromJson(Map<String, dynamic>.from(e)),
        ],
      );
      return orders;
    } on ApiException {
      return const [];
    }
  }
}
