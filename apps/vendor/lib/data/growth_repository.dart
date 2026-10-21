import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../core/api.dart';
import '../models/growth.dart';

/// Offers, reviews, marketing requests, support tickets and the inbox. Every
/// write goes through `/api/vendor/*`; ticket photos go to a one-time signed
/// upload URL the server hands out for the caller's own folder.
class GrowthRepository {
  GrowthRepository(this._api, {http.Client? client}) : _http = client ?? http.Client();

  final ApiClient _api;
  final http.Client _http;

  Future<OffersState> offers() async => OffersState.fromJson(await _api.get('/api/vendor/offers'));
  Future<void> createOffer(Offer o) => _api.post('/api/vendor/offers', o.toJson());
  Future<void> updateOffer(Offer o) => _api.patch('/api/vendor/offers/${Uri.encodeComponent(o.code)}', o.toJson());
  Future<void> setOfferActive(String code, bool active) =>
      _api.patch('/api/vendor/offers/${Uri.encodeComponent(code)}', {'active': active});
  Future<void> deleteOffer(String code) => _api.delete('/api/vendor/offers/${Uri.encodeComponent(code)}');

  Future<ReviewsState> reviews({int days = 90}) async =>
      ReviewsState.fromJson(await _api.get('/api/vendor/reviews', query: {'days': '$days'}));
  Future<void> reply(String reviewId, String text) => _api.post('/api/vendor/reviews/$reviewId/reply', {'text': text});

  Future<List<MarketingRequest>> marketing() async => [
    for (final r in ((await _api.get('/api/vendor/marketing'))['requests'] as List? ?? const []))
      MarketingRequest.fromJson((r as Map).cast<String, dynamic>()),
  ];
  Future<void> requestMarketing(Map<String, Object?> body) => _api.post('/api/vendor/marketing', body);
  Future<void> cancelMarketing(String id) => _api.post('/api/vendor/marketing/$id/cancel');

  Future<List<Ticket>> tickets() async => [
    for (final t in ((await _api.get('/api/vendor/support'))['tickets'] as List? ?? const []))
      Ticket.fromJson((t as Map).cast<String, dynamic>()),
  ];
  Future<TicketThread> ticket(String id) async => TicketThread.fromJson(await _api.get('/api/vendor/support/$id'));
  Future<String> openTicket(Map<String, Object?> body) async =>
      (((await _api.post('/api/vendor/support', body))['ticket'] as Map)['id']) as String;
  Future<void> replyTicket(String id, String body, List<String> attachments) =>
      _api.post('/api/vendor/support/$id/messages', {'body': body, 'attachments': attachments});

  /// Uploads one JPEG and returns its storage path, to cite in a ticket.
  Future<String> uploadPhoto(Uint8List jpeg) async {
    final slot = await _api.post('/api/vendor/support/attachments', {'type': 'jpg'});
    final res = await _http.put(
      Uri.parse(slot['url'] as String),
      headers: {'content-type': 'image/jpeg', 'x-upsert': 'false'},
      body: jpeg,
    );
    if (res.statusCode >= 300) throw ApiException(res.statusCode, 'upload_failed');
    return slot['path'] as String;
  }

  Future<Inbox> inbox({DateTime? before}) async => Inbox.fromJson(
    await _api.get(
      '/api/vendor/notifications',
      query: before == null ? null : {'before': before.toUtc().toIso8601String()},
    ),
  );
  Future<void> markRead(List<String> ids) => _api.post('/api/vendor/notifications', {'ids': ids});
  Future<void> markAllRead() => _api.post('/api/vendor/notifications', {'all': true});
}
