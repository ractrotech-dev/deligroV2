import 'dart:io';

import 'package:http_parser/http_parser.dart' show MediaType;

import '../core/api.dart';
import '../models/jobs.dart';
import '../models/queued_action.dart';

/// The rider's jobs: the board, the answer to an offer, the steps of a delivery
/// and exceptions. [ApiJobsRepository] talks to `/api/rider/*`; a debug build can
/// swap in the fixture backend (data/fixtures), which implements the same thing.
///
/// Every method throws [ApiException] for a refusal or a dead connection,
/// except [act], which turns the server's definitive answers into an
/// [ActionOutcome] and throws only for "try again" ones (see its doc).
abstract interface class JobsRepository {
  /// `GET /api/rider/board`.
  Future<RiderBoard> board();

  /// 409 `reserved`, `offer_expired`, `already_taken`, `not_ready`, `not_online`,
  /// `rejected`; 503 `migration_pending`.
  Future<void> accept(String orderId);

  /// [reason] is `too_far`, `vehicle_issue`, `on_break`, `low_battery` or
  /// `other`. 409 `not_offered`.
  Future<void> reject(String orderId, String reason, {String? note});

  /// `POST …/action`. Returns `applied`, `duplicate`, `rejected(code)` or
  /// `orderGone`. Throws [ApiException] when the answer means "try again":
  /// no connection, 5xx, 429 `rate_limited` or 401. Those never lose the action.
  Future<ActionOutcome> act(QueuedAction a);

  /// Uploads the proof-of-delivery photo; returns the path to send as
  /// `photoPath` with `deliver`.
  Future<String> uploadProof(String orderId, File photo);

  /// Records a Call tap (`customer` or `vendor`), which "customer unreachable"
  /// rests on.
  Future<void> logContact(String orderId, String target);

  /// Raises a request or report; returns its id. 409 `not_yours`,
  /// `duplicate_pending`, `call_first`, `wait_longer` (body `minutesLeft`),
  /// `bad_state`, `invalid_kind`.
  Future<String> raiseException({
    required String orderId,
    required String kind,
    required String reason,
    String? notes,
    String? photoPath,
    double? lat,
    double? lng,
  });
}

class ApiJobsRepository implements JobsRepository {
  ApiJobsRepository(this._api);

  final ApiClient _api;

  @override
  Future<RiderBoard> board() async {
    final res = await _api.get('/api/rider/board');
    try {
      return RiderBoard.fromJson(res);
    } on FormatException {
      throw ApiException(500, 'bad_response');
    } on TypeError {
      throw ApiException(500, 'bad_response');
    }
  }

  @override
  Future<void> accept(String orderId) async {
    await _api.post('/api/rider/offers/$orderId/accept');
  }

  @override
  Future<void> reject(String orderId, String reason, {String? note}) async {
    await _api.post('/api/rider/offers/$orderId/reject', {
      'reason': reason,
      if (note != null && note.trim().isNotEmpty) 'note': note.trim(),
    });
  }

  @override
  Future<ActionOutcome> act(QueuedAction a) async {
    try {
      final res = await _api.post('/api/rider/deliveries/${a.orderId}/action', a.requestBody());
      return ActionOutcome(
        res['duplicate'] == true ? ActionOutcomeKind.duplicate : ActionOutcomeKind.applied,
        actionId: a.actionId,
        orderId: a.orderId,
      );
    } on ApiException catch (e) {
      // `not_found` is the route's answer for a delivery that is not this
      // rider's, which is also what a delivery handed to someone else becomes.
      // Any other 404 is a server without the route: not a verdict.
      if (e.code == 'order_not_active' || (e.status == 404 && e.code == 'not_found')) {
        return ActionOutcome(ActionOutcomeKind.orderGone, actionId: a.actionId, orderId: a.orderId, code: e.code);
      }
      if (_tryAgain(e)) rethrow;
      return ActionOutcome(ActionOutcomeKind.rejected, actionId: a.actionId, orderId: a.orderId, code: e.code);
    }
  }

  /// An answer that says nothing about the action itself.
  static bool _tryAgain(ApiException e) =>
      e.transient || e.serverUnsupported || e.unauthorized || e.status == 429 || e.code == 'rate_limited';

  @override
  Future<String> uploadProof(String orderId, File photo) async {
    final png = photo.path.toLowerCase().endsWith('.png');
    final res = await _api.upload(
      '/api/rider/deliveries/$orderId/proof',
      'file',
      photo,
      contentType: MediaType('image', png ? 'png' : 'jpeg'),
    );
    final path = res['path'];
    if (path is! String || path.isEmpty) throw ApiException(500, 'bad_response');
    return path;
  }

  @override
  Future<void> logContact(String orderId, String target) async {
    await _api.post('/api/rider/deliveries/$orderId/contact', {'target': target});
  }

  @override
  Future<String> raiseException({
    required String orderId,
    required String kind,
    required String reason,
    String? notes,
    String? photoPath,
    double? lat,
    double? lng,
  }) async {
    final res = await _api.post('/api/rider/exceptions', {
      'orderId': orderId,
      'kind': kind,
      'reason': reason,
      if (notes != null && notes.trim().isNotEmpty) 'notes': notes.trim(),
      'photoPath': ?photoPath,
      if (lat != null && lng != null) 'lat': lat,
      if (lat != null && lng != null) 'lng': lng,
    });
    final id = res['id'];
    if (id is! String) throw ApiException(500, 'bad_response');
    return id;
  }
}
