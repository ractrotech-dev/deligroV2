// The offline action queue, the cached active delivery and the jobs repository's
// mapping of server answers. No network: the repository is a fake, or the real
// one over a MockClient.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:deligro_rider/core/action_queue.dart';
import 'package:deligro_rider/core/active_cache.dart';
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/data/jobs_repository.dart';
import 'package:deligro_rider/models/jobs.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

const _orderA = '11111111-1111-4111-8111-111111111111';
const _orderB = '22222222-2222-4222-8222-222222222222';

QueuedAction _action(
  String id,
  String order,
  String action, {
  String? code,
  String? method,
  String? photoPath,
}) =>
    QueuedAction(
      actionId: id,
      orderId: order,
      action: action,
      code: code,
      method: method,
      photoPath: photoPath,
      queuedAt: DateTime.utc(2026, 10, 21, 9),
    );

/// A repository whose `act` answers from a script, keyed by action id. An id
/// with no script entry is applied. Everything else is unused by the queue.
class _FakeRepo implements JobsRepository {
  /// `ActionOutcome` to return, or an `Object` to throw, per action id.
  final script = <String, Object>{};
  final sent = <String>[];

  /// Throw a network error for every call.
  bool offline = false;

  /// Every call in order: `upload:<file>` and `act:<id>:<photoPath>`.
  final log = <String>[];

  /// Thrown by the next uploads, when set.
  Object? uploadError;

  @override
  Future<ActionOutcome> act(QueuedAction a) async {
    if (offline) throw ApiException(0, 'network');
    sent.add(a.actionId);
    log.add('act:${a.actionId}:${a.photoPath}');
    final r = script[a.actionId];
    if (r is ActionOutcome) return r;
    if (r != null) throw r;
    return ActionOutcome(ActionOutcomeKind.applied, actionId: a.actionId, orderId: a.orderId);
  }

  @override
  Future<String> uploadProof(String orderId, File photo) async {
    if (offline) throw ApiException(0, 'network');
    final e = uploadError;
    if (e != null) throw e;
    await photo.readAsBytes(); // the real upload reads the file
    log.add('upload:${photo.path.split(Platform.pathSeparator).last.split('/').last}');
    return '$orderId/server.jpg';
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError('${invocation.memberName}');
}

/// Holds every `act` until the test lets it through, one at a time.
class _GatedRepo implements JobsRepository {
  final sent = <String>[];
  final _gates = <Completer<void>>[];

  void release() {
    for (final g in _gates) {
      if (!g.isCompleted) {
        g.complete();
        return;
      }
    }
  }

  @override
  Future<ActionOutcome> act(QueuedAction a) async {
    sent.add(a.actionId);
    final gate = Completer<void>();
    _gates.add(gate);
    await gate.future;
    return ActionOutcome(ActionOutcomeKind.applied, actionId: a.actionId, orderId: a.orderId);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError('${invocation.memberName}');
}

Future<(ActionQueue, _FakeRepo, ActiveDeliveryCache, SharedPreferences)> _setup({
  Map<String, Object> initial = const {},
  DateTime Function()? clock,
}) async {
  SharedPreferences.setMockInitialValues(initial);
  final prefs = await SharedPreferences.getInstance();
  final repo = _FakeRepo();
  final cache = ActiveDeliveryCache(prefs);
  final queue = ActionQueue(repo, prefs, cache, clock: clock);
  return (queue, repo, cache, prefs);
}

void main() {
  final now = DateTime.utc(2026, 10, 21, 9);

  group('ActionQueue', () {
    test('a network failure queues the action and pending emits it', () async {
      final (queue, repo, _, _) = await _setup();
      repo.offline = true;
      final seen = <List<QueuedAction>>[];
      final sub = queue.pending.listen(seen.add);
      addTearDown(sub.cancel);
      await pumpEventQueue();

      final outcome = await queue.submit(_action('a1', _orderA, 'arrive_pickup'));
      await pumpEventQueue();

      expect(outcome.kind, ActionOutcomeKind.queued);
      expect(seen.first, isEmpty);
      expect(seen.last.map((a) => a.actionId), ['a1']);
      expect(queue.current, hasLength(1));
    });

    test('an online submit is sent and not kept', () async {
      final (queue, repo, _, prefs) = await _setup();

      final outcome = await queue.submit(_action('a1', _orderA, 'arrive_pickup'));

      expect(outcome.kind, ActionOutcomeKind.applied);
      expect(repo.sent, ['a1']);
      expect(queue.current, isEmpty);
      expect(jsonDecode(prefs.getString('action_queue_v1') ?? '[]'), isEmpty);
    });

    test('5xx and a transient answer keep the action queued', () async {
      final (queue, repo, _, _) = await _setup();
      repo.script['a1'] = ApiException(503, 'migration_pending');
      repo.script['a2'] = ApiException(502, 'http_502');

      expect((await queue.submit(_action('a1', _orderA, 'arrive_pickup'))).kind, ActionOutcomeKind.queued);
      expect((await queue.submit(_action('a2', _orderB, 'arrive_pickup'))).kind, ActionOutcomeKind.queued);
      expect(queue.current.map((a) => a.actionId), ['a1', 'a2']);
    });

    test('flush sends in order per order and empties the queue', () async {
      final (queue, repo, _, _) = await _setup();
      repo.offline = true;
      await queue.submit(_action('a1', _orderA, 'arrive_pickup'));
      await queue.submit(_action('b1', _orderB, 'arrive_pickup'));
      await queue.submit(_action('a2', _orderA, 'pickup', code: '1234', method: 'code'));
      await queue.submit(_action('a3', _orderA, 'start_trip'));
      expect(queue.current, hasLength(4));

      repo.offline = false;
      final outcomes = await queue.flush();

      expect(outcomes.map((o) => o.kind), everyElement(ActionOutcomeKind.applied));
      expect(repo.sent.where((id) => id.startsWith('a')), ['a1', 'a2', 'a3']);
      expect(repo.sent, hasLength(4));
      expect(queue.current, isEmpty);
    });

    test('a later submit for an order waits behind its earlier queued actions', () async {
      final (queue, repo, _, _) = await _setup();
      repo.offline = true;
      await queue.submit(_action('a1', _orderA, 'arrive_pickup'));

      repo.offline = false;
      final outcome = await queue.submit(_action('a2', _orderA, 'pickup', code: '1234'));

      expect(outcome.kind, ActionOutcomeKind.applied);
      expect(repo.sent, ['a1', 'a2'], reason: 'the earlier tap goes first');
      expect(queue.current, isEmpty);
    });

    test('flush stops an order at its first unsent action', () async {
      final (queue, repo, _, _) = await _setup();
      repo.offline = true;
      await queue.submit(_action('a1', _orderA, 'arrive_pickup'));
      await queue.submit(_action('a2', _orderA, 'pickup'));
      repo.offline = false;
      repo.script['a1'] = ApiException(502, 'http_502');

      await queue.flush();

      expect(repo.sent, ['a1'], reason: 'a2 must not overtake a1');
      expect(queue.current.map((a) => a.actionId), ['a1', 'a2']);
    });

    test('a duplicate answer counts as applied', () async {
      final (queue, repo, _, _) = await _setup();
      repo.script['a1'] = const ActionOutcome(ActionOutcomeKind.duplicate, actionId: 'a1');

      final outcome = await queue.submit(_action('a1', _orderA, 'arrive_pickup'));

      expect(outcome.kind, ActionOutcomeKind.duplicate);
      expect(outcome.done, isTrue);
      expect(queue.current, isEmpty);
    });

    test('bad_otp on replay surfaces rejected and removes only that action', () async {
      final (queue, repo, _, _) = await _setup();
      repo.offline = true;
      await queue.submit(_action('a1', _orderA, 'deliver', code: '0000', method: 'code'));
      await queue.submit(_action('b1', _orderB, 'arrive_pickup'));
      repo.offline = false;
      repo.script['a1'] = ActionOutcome(
        ActionOutcomeKind.rejected,
        actionId: 'a1',
        orderId: _orderA,
        code: 'bad_otp',
      );

      final outcomes = await queue.flush();

      final rejected = outcomes.singleWhere((o) => o.kind == ActionOutcomeKind.rejected);
      expect(rejected.code, 'bad_otp');
      expect(rejected.actionId, 'a1');
      expect(outcomes.where((o) => o.kind == ActionOutcomeKind.applied), hasLength(1));
      expect(queue.current, isEmpty);
    });

    test('a rejected action does not block the next one for the order', () async {
      final (queue, repo, _, _) = await _setup();
      repo.offline = true;
      await queue.submit(_action('a1', _orderA, 'deliver', code: '0000'));
      await queue.submit(_action('a2', _orderA, 'deliver', code: '1234'));
      repo.offline = false;
      repo.script['a1'] = const ActionOutcome(ActionOutcomeKind.rejected, actionId: 'a1', code: 'bad_otp');

      await queue.flush();

      expect(repo.sent, ['a1', 'a2']);
      expect(queue.current, isEmpty);
    });

    test('order_not_active drops every queued action for the order and clears the cache', () async {
      final (queue, repo, cache, _) = await _setup();
      final active = RiderActive.fromJson(FixtureData.active('picked_up', now: now));
      await cache.save(active);
      expect(cache.load(), isNotNull);
      repo.offline = true;
      await queue.submit(_action('a1', active.orderId, 'arrive_drop'));
      await queue.submit(_action('a2', active.orderId, 'deliver'));
      await queue.submit(_action('b1', _orderB, 'arrive_pickup'));
      repo.offline = false;
      repo.script['a1'] = const ActionOutcome(ActionOutcomeKind.orderGone, actionId: 'a1');

      final outcomes = await queue.flush();

      expect(outcomes.map((o) => o.kind), contains(ActionOutcomeKind.orderGone));
      expect(repo.sent, isNot(contains('a2')), reason: 'nothing more is sent for a gone order');
      expect(queue.current, isEmpty, reason: 'b1 was applied, a1 and a2 dropped');
      expect(cache.load(), isNull);
    });

    test('orderGone leaves the cache of a different order alone', () async {
      final (queue, repo, cache, _) = await _setup();
      await cache.save(RiderActive.fromJson(FixtureData.active('picked_up', now: now)));
      repo.script['x1'] = const ActionOutcome(ActionOutcomeKind.orderGone, actionId: 'x1');

      await queue.submit(_action('x1', _orderB, 'deliver'));

      expect(cache.load(), isNotNull);
    });

    test('a 429 keeps everything queued and backs off', () async {
      var clock = now;
      final (queue, repo, _, _) = await _setup(clock: () => clock);
      repo.script['a1'] = ApiException(429, 'rate_limited', body: {'retryAfter': 30});

      expect((await queue.submit(_action('a1', _orderA, 'pickup', code: '1234'))).kind, ActionOutcomeKind.queued);
      expect(repo.sent, ['a1']);

      // Inside the backoff nothing is sent.
      clock = clock.add(const Duration(seconds: 10));
      repo.script.remove('a1');
      expect(await queue.flush(), isEmpty);
      expect(repo.sent, ['a1']);
      expect(queue.current, hasLength(1));

      // After it, the flush goes through.
      clock = clock.add(const Duration(seconds: 25));
      final outcomes = await queue.flush();
      expect(outcomes.single.kind, ActionOutcomeKind.applied);
      expect(queue.current, isEmpty);
    });

    test('the queue survives a new SharedPreferences instance', () async {
      final (queue, repo, _, prefs) = await _setup();
      repo.offline = true;
      await queue.submit(_action('a1', _orderA, 'pickup', code: '1234', method: 'code'));
      await queue.submit(_action('a2', _orderA, 'deliver', method: 'photo', photoPath: 'd/p.jpg'));

      SharedPreferences.setMockInitialValues({
        'action_queue_v1': prefs.getString('action_queue_v1')!,
      });
      final fresh = await SharedPreferences.getInstance();
      expect(identical(fresh, prefs), isFalse);
      final repo2 = _FakeRepo();
      final queue2 = ActionQueue(repo2, fresh, ActiveDeliveryCache(fresh));

      expect(queue2.current.map((a) => a.actionId), ['a1', 'a2']);
      final first = queue2.current.first;
      expect((first.code, first.method, first.orderId), ('1234', 'code', _orderA));
      expect(queue2.current.last.photoPath, 'd/p.jpg');

      await queue2.flush();
      expect(repo2.sent, ['a1', 'a2']);
      expect(queue2.current, isEmpty);
    });

    test('a corrupt stored queue is ignored', () async {
      final (queue, _, _, _) = await _setup(initial: {'action_queue_v1': '{not json'});
      expect(queue.current, isEmpty);
    });
  });

  group('ActiveDeliveryCache', () {
    test('saves, loads and clears the active delivery', () async {
      final (_, _, cache, prefs) = await _setup();
      expect(cache.load(), isNull);
      final active = RiderActive.fromJson(FixtureData.active('on_the_way', now: now));

      await cache.save(active);
      final loaded = ActiveDeliveryCache(prefs).load();
      expect(loaded?.orderId, active.orderId);
      expect(loaded?.status, RiderDeliveryStatus.onTheWay);
      expect(jsonEncode(loaded!.toJson()), jsonEncode(active.toJson()));

      await cache.clear();
      expect(cache.load(), isNull);
    });
  });

  group('ApiJobsRepository', () {
    late List<http.Request> seen;
    late int status;
    late Object body;
    late bool offline;

    ApiJobsRepository repo() {
      final supabase = SupabaseClient(
        'http://localhost:1',
        'test-key',
        authOptions: const AuthClientOptions(autoRefreshToken: false),
      );
      addTearDown(() => unawaited(supabase.dispose()));
      final client = MockClient((req) async {
        seen.add(req);
        if (offline) throw http.ClientException('no route');
        return http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});
      });
      return ApiJobsRepository(ApiClient(supabase.auth, client: client));
    }

    setUp(() {
      seen = [];
      status = 200;
      body = {'ok': true};
      offline = false;
    });

    Future<ActionOutcome> act() => repo().act(
          _action('a1', _orderA, 'pickup', code: '1234', method: 'code'),
        );

    test('act posts the action body to the order route', () async {
      final outcome = await act();

      expect(outcome.kind, ActionOutcomeKind.applied);
      expect(seen.single.url.path, '/api/rider/deliveries/$_orderA/action');
      expect(jsonDecode(seen.single.body), {
        'action': 'pickup',
        'actionId': 'a1',
        'code': '1234',
        'method': 'code',
      });
    });

    test('act maps the server answers', () async {
      body = {'ok': true, 'duplicate': true};
      expect((await act()).kind, ActionOutcomeKind.duplicate);

      status = 409;
      body = {'error': 'order_not_active'};
      expect((await act()).kind, ActionOutcomeKind.orderGone);

      body = {'error': 'bad_otp'};
      final bad = await act();
      expect(bad.kind, ActionOutcomeKind.rejected);
      expect(bad.code, 'bad_otp');

      status = 404;
      body = {'error': 'not_found'};
      expect((await act()).kind, ActionOutcomeKind.orderGone, reason: 'no longer this delivery');

      for (final code in ['photo_required', 'bad_state', 'bad_pickup_otp', 'manual_not_approved']) {
        status = 409;
        body = {'error': code};
        expect((await act()).code, code);
      }
    });

    test('act throws for answers that mean "try again"', () async {
      status = 429;
      body = {'error': 'rate_limited', 'retryAfter': 12};
      await expectLater(act(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 429)));

      status = 503;
      body = {'error': 'migration_pending'};
      await expectLater(act(), throwsA(isA<ApiException>().having((e) => e.transient, 'transient', true)));

      offline = true;
      await expectLater(act(), throwsA(isA<ApiException>().having((e) => e.status, 'status', 0)));
    });

    test('a queue over the real repository keeps a network failure queued', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      offline = true;
      final queue = ActionQueue(repo(), prefs, ActiveDeliveryCache(prefs));

      final outcome = await queue.submit(_action('a1', _orderA, 'arrive_pickup'));
      expect(outcome.kind, ActionOutcomeKind.queued);
    });

    test('accept, reject, contact and exception hit their routes', () async {
      final r = repo();
      await r.accept(_orderA);
      await r.reject(_orderA, 'too_far', note: 'raining');
      await r.logContact(_orderA, 'customer');
      body = {'ok': true, 'id': 'ex-1'};
      final id = await r.raiseException(
        orderId: _orderA,
        kind: 'customer_unreachable',
        reason: 'no answer',
        lat: 12.5,
        lng: 77.5,
      );

      expect(id, 'ex-1');
      expect(seen.map((q) => q.url.path), [
        '/api/rider/offers/$_orderA/accept',
        '/api/rider/offers/$_orderA/reject',
        '/api/rider/deliveries/$_orderA/contact',
        '/api/rider/exceptions',
      ]);
      expect(jsonDecode(seen[1].body), {'reason': 'too_far', 'note': 'raining'});
      expect(jsonDecode(seen[2].body), {'target': 'customer'});
      expect(jsonDecode(seen[3].body), {
        'orderId': _orderA,
        'kind': 'customer_unreachable',
        'reason': 'no answer',
        'lat': 12.5,
        'lng': 77.5,
      });
    });

    test('uploadProof sends the file as multipart with an image type', () async {
      final dir = await Directory.systemTemp.createTemp('proof');
      addTearDown(() => dir.delete(recursive: true));
      final photo = File('${dir.path}/pod.jpg')..writeAsStringSync('not-really-a-jpeg');
      body = {'ok': true, 'path': 'dlv/abc.jpg'};

      final path = await repo().uploadProof(_orderA, photo);

      expect(path, 'dlv/abc.jpg');
      expect(seen.single.url.path, '/api/rider/deliveries/$_orderA/proof');
      expect(seen.single.headers['content-type'], startsWith('multipart/form-data'));
      expect(seen.single.body, contains('name="file"'));
      expect(seen.single.body, contains('image/jpeg'));
    });

    test('board maps an unreadable body to a transient error', () async {
      body = {'offers': 'nope'};
      await expectLater(
        repo().board(),
        throwsA(isA<ApiException>().having((e) => e.transient, 'transient', true)),
      );
    });
  });

  group('ActionQueue, carried from the Task 5 review', () {
    test('flush and submit while a request is in flight never send one action twice', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final repo = _GatedRepo();
      final queue = ActionQueue(repo, prefs, ActiveDeliveryCache(prefs));

      // a1 is on the wire and held there.
      final first = queue.submit(_action('a1', _orderA, 'arrive_pickup'));
      await pumpEventQueue();
      expect(repo.sent, ['a1']);

      // Meanwhile: a board refresh flushes twice, and the rider taps again.
      final flushes = [queue.flush(), queue.flush()];
      final second = queue.submit(_action('a2', _orderA, 'pickup', code: '1234'));
      final replay = queue.submit(_action('a1', _orderA, 'arrive_pickup'));
      await pumpEventQueue();
      expect(repo.sent, ['a1'], reason: 'nothing else goes out while a1 is open');

      repo.release();
      await pumpEventQueue();
      repo.release();
      await Future.wait([first, second, replay, ...flushes]);
      repo.release();
      await pumpEventQueue();

      expect(repo.sent, ['a1', 'a2']);
      expect((await first).kind, ActionOutcomeKind.applied);
      expect((await second).kind, ActionOutcomeKind.applied);
      expect(queue.current, isEmpty);
    });

    test('a saved queue with one unreadable item keeps the others', () async {
      final good = _action('a1', _orderA, 'arrive_pickup').toJson();
      final alsoGood = _action('a2', _orderB, 'arrive_drop').toJson();
      final (queue, _, _, _) = await _setup(initial: {
        ActionQueue.key: jsonEncode([
          good,
          {'actionId': 42, 'orderId': null},
          'not even a map',
          alsoGood,
        ]),
      });
      expect(queue.current.map((a) => a.actionId), ['a1', 'a2']);
    });

    test('a saved queue that is not JSON at all is empty, not a crash', () async {
      final (queue, _, _, _) = await _setup(initial: {ActionQueue.key: '{nope'});
      expect(queue.current, isEmpty);
    });

    test('every answer is also on the outcomes stream, from flush as from submit', () async {
      final (queue, repo, _, _) = await _setup();
      final heard = <ActionOutcome>[];
      final sub = queue.outcomes.listen(heard.add);
      addTearDown(sub.cancel);

      repo.offline = true;
      await queue.submit(_action('a1', _orderA, 'arrive_pickup'));
      repo.offline = false;
      repo.script['a2'] = ActionOutcome(ActionOutcomeKind.rejected, actionId: 'a2', orderId: _orderA, code: 'bad_pickup_otp');
      await queue.submit(_action('a2', _orderA, 'pickup', code: '9'));
      await pumpEventQueue();

      expect(heard.map((o) => (o.actionId, o.kind)), [
        ('a1', ActionOutcomeKind.applied),
        ('a2', ActionOutcomeKind.rejected),
      ]);
    });
  });

  group('ActionQueue, Task 7 review fixes', () {
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('proof_'));
    tearDown(() async {
      // The queue deletes kept photos without waiting: let that finish first.
      await Future<void>.delayed(const Duration(milliseconds: 50));
      if (dir.existsSync()) dir.deleteSync(recursive: true);
    });

    File keptPhoto() => File('${dir.path}/kept.jpg')..writeAsBytesSync([0xff, 0xd8, 0xff]);

    QueuedAction deliverWithPhoto(String path) => QueuedAction(
          actionId: 'd1',
          orderId: _orderA,
          action: 'deliver',
          code: '1234',
          method: 'code',
          localPhoto: path,
          queuedAt: DateTime.utc(2026, 10, 21, 9),
        );

    test('a deliver saved with a photo on the phone: kept across a restart, then upload, then deliver', () async {
      final (queue, repo, _, prefs) = await _setup();
      final photo = keptPhoto();
      repo.offline = true;
      await queue.submit(_action('a0', _orderA, 'arrive_drop'));
      final out = await queue.submit(deliverWithPhoto(photo.path));
      expect(out.kind, ActionOutcomeKind.queued);

      // The app is killed and opened again.
      SharedPreferences.setMockInitialValues({'action_queue_v1': prefs.getString('action_queue_v1')!});
      final fresh = await SharedPreferences.getInstance();
      final repo2 = _FakeRepo();
      final queue2 = ActionQueue(repo2, fresh, ActiveDeliveryCache(fresh));
      final saved = queue2.current.last;
      expect((saved.action, saved.localPhoto, saved.photoPath), ('deliver', photo.path, null));
      expect(saved.requestBody().containsKey('localPhoto'), isFalse, reason: 'a phone path never goes to the server');

      final outcomes = await queue2.flush();
      expect(repo2.log, ['act:a0:null', 'upload:kept.jpg', 'act:d1:$_orderA/server.jpg']);
      expect(outcomes.last.action, 'deliver');
      expect(outcomes.last.done, isTrue);
      expect(queue2.current, isEmpty);
      for (var i = 0; i < 50 && photo.existsSync(); i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(photo.existsSync(), isFalse, reason: 'the kept copy is deleted once the step is done');
    });

    test('an uploaded photo is saved with the step: a lost deliver does not upload it again', () async {
      final (queue, repo, _, _) = await _setup();
      final photo = keptPhoto();
      repo.script['d1'] = ApiException(0, 'network');
      await queue.submit(deliverWithPhoto(photo.path));
      expect(queue.current.single.photoPath, '$_orderA/server.jpg');

      repo.script.remove('d1');
      await queue.flush();
      expect(repo.log, ['upload:kept.jpg', 'act:d1:$_orderA/server.jpg', 'act:d1:$_orderA/server.jpg']);
      expect(queue.current, isEmpty);
    });

    test('no signal for the upload keeps the step queued; a photo the server refuses is reported', () async {
      final (queue, repo, _, _) = await _setup();
      final photo = keptPhoto();
      repo.uploadError = ApiException(0, 'network');
      expect((await queue.submit(deliverWithPhoto(photo.path))).kind, ActionOutcomeKind.queued);
      expect(repo.sent, isEmpty);
      expect(queue.current, hasLength(1));

      repo.uploadError = ApiException(400, 'too_large');
      final outcomes = await queue.flush();
      expect((outcomes.single.kind, outcomes.single.code), (ActionOutcomeKind.rejected, 'too_large'));
      expect(repo.sent, isEmpty, reason: 'the deliver is not sent without its photo');
      expect(queue.current, isEmpty);
    });

    test('a kept photo that has gone missing asks for a retake', () async {
      final (queue, _, _, _) = await _setup();
      final out = await queue.submit(deliverWithPhoto('${dir.path}/gone.jpg'));
      expect((out.kind, out.code), (ActionOutcomeKind.rejected, 'invalid_photo'));
    });

    test('a delivered step clears the kept copy of the delivery', () async {
      final (queue, _, cache, _) = await _setup();
      final active = RiderActive.fromJson(FixtureData.active('arrived_drop', now: now));
      await cache.save(active);
      await queue.submit(_action('a1', active.orderId, 'arrive_drop'));
      expect(cache.load(), isNotNull, reason: 'any other step leaves it');
      final out = await queue.submit(_action('d1', active.orderId, 'deliver', code: '1234'));
      expect(out.action, 'deliver');
      expect(cache.load(), isNull);
    });
  });
}
