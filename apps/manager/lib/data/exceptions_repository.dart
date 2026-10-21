import '../core/api.dart';
import '../models/delivery_exception.dart';
import '../models/outcome.dart';

/// Delivery exceptions raised by riders — `/api/manager/exceptions*`.
abstract interface class ExceptionsRepository {
  Future<ExceptionPage> list({String status = 'pending', String? riderId, String? cursor});

  /// A 60-second signed URL for the rider's photo.
  Future<String> photoUrl(String id);

  /// 409 `already_resolved` → [Refused]. A 502 `effect_failed` (decision
  /// saved, its after-effect failed) and any fault throw [ApiException], so
  /// the screen offers Retry with the very same action.
  Future<Outcome<DeliveryException>> decide(String id, ExceptionAction a);
}

class ApiExceptionsRepository implements ExceptionsRepository {
  ApiExceptionsRepository(this._api);
  final ApiClient _api;

  @override
  Future<ExceptionPage> list({String status = 'pending', String? riderId, String? cursor}) async =>
      ExceptionPage.fromJson(await _api.get('/api/manager/exceptions', query: {
        'status': status,
        'rider': ?riderId,
        'cursor': ?cursor,
      }));

  @override
  Future<String> photoUrl(String id) async =>
      '${(await _api.get('/api/manager/exceptions/${Uri.encodeComponent(id)}/photo'))['url']}';

  @override
  Future<Outcome<DeliveryException>> decide(String id, ExceptionAction a) => runAction(
        () => _api.post('/api/manager/exceptions/${Uri.encodeComponent(id)}/decide', a.toJson()),
        (res) => res['exception'] is Map
            ? DeliveryException.fromJson((res['exception'] as Map).cast<String, dynamic>())
            : null,
      );
}
