import 'dart:io';

import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../models/jobs.dart';
import '../../models/queued_action.dart';
import '../jobs_repository.dart';
import 'fixture_data.dart';

export 'fixture_data.dart' show FixtureData, fixtureCode;

/// Whether this build serves jobs from fixtures instead of the website: only
/// when started with `--dart-define=FIXTURES=true` **and** not a release build.
/// `kReleaseMode` is a compile-time constant, so in a release build this is a
/// constant false and the code behind it, the fixture data included, is
/// removed from the app. It is used to screenshot the job screens on an emulator
/// without a server and without a rider to hand.
const bool fixturesEnabled = bool.fromEnvironment('FIXTURES') && !kReleaseMode;

/// Which board a fixture session starts with (`--dart-define=FIXTURE_SCENARIO=`),
/// one of [FixtureData.scenarios].
const String fixtureScenario = String.fromEnvironment('FIXTURE_SCENARIO', defaultValue: 'offers');

/// [JobsRepository] over in-memory JSON. Accepting an offer makes it the active
/// delivery, and delivery steps move it along as the server would, with the
/// code [fixtureCode] accepted wherever a code is asked for.
class FixtureJobsRepository implements JobsRepository {
  FixtureJobsRepository._(this._state, this._now);

  /// Throws in a release build, twice over: an assert for debug runs, and a
  /// plain check that is still there with asserts off. [releaseMode] is for
  /// the test that proves the refusal.
  factory FixtureJobsRepository.create({
    String scenario = fixtureScenario,
    DateTime? now,
    @visibleForTesting bool releaseMode = kReleaseMode,
  }) {
    assert(!kReleaseMode, 'the fixture backend must never be built in a release build');
    if (releaseMode) {
      throw StateError('the fixture backend is not available in a release build');
    }
    final at = now ?? DateTime.now();
    return FixtureJobsRepository._(FixtureData.board(scenario, now: at), at);
  }

  Map<String, dynamic> _state;
  final DateTime _now;
  final _seen = <String>{};
  var _raised = 0;

  Map<String, dynamic>? get _active => _state['active'] as Map<String, dynamic>?;

  List<Map<String, dynamic>> get _offers => (_state['offers'] as List).cast<Map<String, dynamic>>();

  List<Map<String, dynamic>> get _upcoming => (_state['upcoming'] as List).cast<Map<String, dynamic>>();

  @override
  Future<RiderBoard> board() async => RiderBoard.fromJson(_state);

  @override
  Future<void> accept(String orderId) async {
    Map<String, dynamic>? offer = _offers.where((o) => o['orderId'] == orderId).firstOrNull;
    offer ??= _upcoming
        .map((u) => u['offer'] as Map<String, dynamic>)
        .where((o) => o['orderId'] == orderId)
        .firstOrNull;
    if (offer == null || _active != null) throw ApiException(409, 'already_taken');
    _state = {
      ..._state,
      'offers': _offers.where((o) => o['orderId'] != orderId).toList(),
      'upcoming': _upcoming.where((u) => (u['offer'] as Map)['orderId'] != orderId).toList(),
      'active': FixtureData.activeFromOffer(offer, now: _now),
    };
  }

  @override
  Future<void> reject(String orderId, String reason, {String? note}) async {
    if (!_offers.any((o) => o['orderId'] == orderId)) throw ApiException(409, 'not_offered');
    _state = {..._state, 'offers': _offers.where((o) => o['orderId'] != orderId).toList()};
  }

  /// Action -> (status it needs, status it leads to, timeline event it writes).
  static const _steps = {
    'arrive_pickup': ('accepted', 'arrived_pickup', 'arrived_pickup'),
    'pickup': ('arrived_pickup', 'picked_up', 'picked_up'),
    'start_trip': ('picked_up', 'on_the_way', 'departed'),
    'arrive_drop': ('on_the_way', 'arrived_drop', 'arrived_drop'),
    'deliver': ('arrived_drop', 'delivered', 'delivered'),
  };

  @override
  Future<ActionOutcome> act(QueuedAction a) async {
    ActionOutcome out(ActionOutcomeKind kind, [String? code]) =>
        ActionOutcome(kind, actionId: a.actionId, orderId: a.orderId, code: code);

    if (_seen.contains(a.actionId)) return out(ActionOutcomeKind.duplicate);
    final active = _active;
    if (active == null || active['orderId'] != a.orderId) {
      return out(ActionOutcomeKind.orderGone, 'order_not_active');
    }
    final step = _steps[a.action];
    if (step == null || active['status'] != step.$1) return out(ActionOutcomeKind.rejected, 'bad_state');

    final method = a.method ?? 'code';
    if (a.action == 'pickup' && method != 'manual' && a.code != fixtureCode) {
      return out(ActionOutcomeKind.rejected, 'bad_pickup_otp');
    }
    if (a.action == 'deliver') {
      if (method == 'code' && a.code != fixtureCode) return out(ActionOutcomeKind.rejected, 'bad_otp');
      if (method == 'photo' && a.photoPath == null) return out(ActionOutcomeKind.rejected, 'photo_required');
      if (method == 'ops_approved') return out(ActionOutcomeKind.rejected, 'manual_not_approved');
    }

    _seen.add(a.actionId);
    _state = {
      ..._state,
      'active': {
        ...active,
        'status': step.$2,
        if (a.action == 'arrive_drop') 'arrivedDropAt': DateTime.now().toUtc().toIso8601String(),
        'timeline': [
          ...(active['timeline'] as List),
          {
            'kind': step.$3,
            'method': a.method,
            'reason': null,
            'at': DateTime.now().toUtc().toIso8601String(),
          },
        ],
      },
    };
    return out(ActionOutcomeKind.applied);
  }

  @override
  Future<String> uploadProof(String orderId, File photo) async =>
      'f2000000-0000-4000-8000-000000000001/f4000000-0000-4000-8000-000000000001.jpg';

  @override
  Future<void> logContact(String orderId, String target) async {}

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
    final active = _active;
    if (active == null || active['orderId'] != orderId) throw ApiException(409, 'not_yours');
    final list = (active['exceptions'] as List).cast<Map<String, dynamic>>();
    if (list.any((e) => e['kind'] == kind && e['status'] == 'pending')) {
      throw ApiException(409, 'duplicate_pending');
    }
    final id = 'f3100000-0000-4000-8000-${(++_raised).toString().padLeft(12, '0')}';
    _state = {
      ..._state,
      'active': {
        ...active,
        'exceptions': [
          ...list,
          {
            'id': id,
            'kind': kind,
            'status': 'pending',
            'reason': reason,
            'decisionNote': null,
            'createdAt': DateTime.now().toUtc().toIso8601String(),
          },
        ],
      },
    };
    return id;
  }
}
