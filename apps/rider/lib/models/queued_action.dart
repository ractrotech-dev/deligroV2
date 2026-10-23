import 'package:uuid/uuid.dart';

/// One tap on the delivery (arrived, picked up, delivered, …) as the app keeps
/// it until the server has answered. [actionId] is a UUID v4 made when the
/// rider tapped: the server answers a replay of the same id with `duplicate`
/// and changes nothing, which is what makes resending after a lost answer safe.
class QueuedAction {
  const QueuedAction({
    required this.actionId,
    required this.orderId,
    required this.action,
    this.code,
    this.method,
    this.photoPath,
    this.localPhoto,
    this.lat,
    this.lng,
    required this.queuedAt,
    this.uid,
  });

  /// A new tap: the only way the app makes one, so every action id is a fresh
  /// UUID v4 (the action route refuses anything else as `invalid_action_id`).
  factory QueuedAction.create({
    required String orderId,
    required String action,
    String? code,
    String? method,
    String? photoPath,
    String? localPhoto,
    double? lat,
    double? lng,
    DateTime? now,
    String? uid,
  }) =>
      QueuedAction(
        actionId: const Uuid().v4(),
        orderId: orderId,
        action: action,
        code: code,
        method: method,
        photoPath: photoPath,
        localPhoto: localPhoto,
        lat: lat,
        lng: lng,
        queuedAt: now ?? DateTime.now(),
        uid: uid,
      );

  final String actionId;

  /// The user who tapped it. Only their session ever sends it: another rider
  /// signing in on this phone leaves it waiting until this one is back. Null
  /// on a step saved by an earlier build, which goes with whoever is signed
  /// in when it is next sent.
  final String? uid;
  final String orderId;

  /// `arrive_pickup`, `pickup`, `start_trip`, `arrive_drop` or `deliver`.
  final String action;
  final String? code;
  final String? method;

  /// The server-side path `uploadProof` returned, never a local file.
  final String? photoPath;

  /// A proof photo kept on the phone (a copy in the app's documents folder)
  /// for a `deliver` saved with no signal: the queue uploads it before it
  /// sends the step, and sends the server's path as [photoPath]. Never sent
  /// to the server itself.
  final String? localPhoto;

  /// The photo still has to go up before this step can be sent.
  bool get needsUpload => localPhoto != null && photoPath == null;

  /// This step, with the photo on the server at [path].
  QueuedAction withPhotoPath(String path) => _copy(photoPath: path);

  /// This step, belonging to [owner].
  QueuedAction ownedBy(String owner) => _copy(uid: owner);

  QueuedAction _copy({String? photoPath, String? uid}) => QueuedAction(
        actionId: actionId,
        orderId: orderId,
        action: action,
        code: code,
        method: method,
        photoPath: photoPath ?? this.photoPath,
        localPhoto: localPhoto,
        lat: lat,
        lng: lng,
        queuedAt: queuedAt,
        uid: uid ?? this.uid,
      );
  final double? lat;
  final double? lng;
  final DateTime queuedAt;

  /// The POST body for `/api/rider/deliveries/:orderId/action`: empty fields
  /// are left out, as the route reads a missing field and a null differently
  /// for the position pair.
  Map<String, dynamic> requestBody() => {
        'action': action,
        'actionId': actionId,
        if (code != null) 'code': code,
        if (method != null) 'method': method,
        if (photoPath != null) 'photoPath': photoPath,
        if (lat != null && lng != null) 'lat': lat,
        if (lat != null && lng != null) 'lng': lng,
      };

  Map<String, dynamic> toJson() => {
        ...requestBody(),
        'localPhoto': ?localPhoto,
        'uid': ?uid,
        'orderId': orderId,
        'queuedAt': queuedAt.toUtc().toIso8601String(),
      };

  factory QueuedAction.fromJson(Map<String, dynamic> j) => QueuedAction(
        actionId: j['actionId'] as String,
        orderId: j['orderId'] as String,
        action: j['action'] as String,
        code: j['code'] as String?,
        method: j['method'] as String?,
        photoPath: j['photoPath'] as String?,
        localPhoto: j['localPhoto'] as String?,
        lat: (j['lat'] as num?)?.toDouble(),
        lng: (j['lng'] as num?)?.toDouble(),
        queuedAt: DateTime.tryParse('${j['queuedAt']}') ?? DateTime.now(),
        uid: j['uid'] as String?,
      );
}

enum ActionOutcomeKind {
  /// The server did it.
  applied,

  /// The server had already done it (a replay of the same id). Counts as applied.
  duplicate,

  /// Not sent, or no answer: held in the queue and resent later.
  queued,

  /// The server refused this action (`code` says why: `bad_otp`, `bad_state`,
  /// `photo_required`, …). It is not retried.
  rejected,

  /// The order is no longer this rider's to act on (`order_not_active`, or the
  /// delivery is not theirs any more). Everything queued for it is dropped.
  orderGone,
}

class ActionOutcome {
  const ActionOutcome(this.kind, {this.actionId, this.orderId, this.code, this.action});

  final ActionOutcomeKind kind;
  final String? actionId;
  final String? orderId;

  /// The step it answers (`deliver`, …), as the queue reports it.
  final String? action;

  /// The server's error code, for [ActionOutcomeKind.rejected].
  final String? code;

  /// The server has the step: applied, or already had it.
  bool get done => kind == ActionOutcomeKind.applied || kind == ActionOutcomeKind.duplicate;

  @override
  String toString() => 'ActionOutcome($kind${code == null ? '' : ', $code'})';
}
