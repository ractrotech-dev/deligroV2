// Saved delivery steps belong to the rider who tapped them (I-3): another
// rider signing in on the phone never sends them, they and their proof photo
// stay on the phone, and they go when their own rider is back. Sign-out says
// so plainly. No network: the repository is a fake.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:deligro_rider/core/action_queue.dart';
import 'package:deligro_rider/core/active_cache.dart';
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/data/jobs_repository.dart';
import 'package:deligro_rider/features/settings/settings_screen.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _order = '11111111-1111-4111-8111-111111111111';

class _Repo implements JobsRepository {
  bool offline = false;
  final log = <String>[];

  /// When set, the next upload / action waits for the test.
  Completer<void>? uploadGate;
  Completer<ActionOutcome>? actGate;

  @override
  Future<ActionOutcome> act(QueuedAction a) async {
    if (offline) throw ApiException(0, 'network');
    log.add('act:${a.actionId}:${a.photoPath}');
    final gate = actGate;
    if (gate != null) return gate.future;
    return ActionOutcome(ActionOutcomeKind.applied, actionId: a.actionId, orderId: a.orderId);
  }

  @override
  Future<String> uploadProof(String orderId, File photo) async {
    if (offline) throw ApiException(0, 'network');
    await photo.readAsBytes();
    log.add('upload');
    final gate = uploadGate;
    if (gate != null) await gate.future;
    return '$orderId/server.jpg';
  }

  @override
  dynamic noSuchMethod(Invocation i) => throw UnimplementedError('${i.memberName}');
}

class _Uid extends Notifier<String?> {
  @override
  String? build() => 'rider-a';
  void set(String? v) => state = v;
}

final _uid = NotifierProvider<_Uid, String?>(_Uid.new);

Future<void> _tick() async {
  for (var i = 0; i < 6; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  late SharedPreferences prefs;
  late _Repo repo;
  late ProviderContainer c;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();
    repo = _Repo();
    c = ProviderContainer(overrides: [
      prefsProvider.overrideWithValue(prefs),
      userIdProvider.overrideWith((ref) => ref.watch(_uid)),
      jobsRepoProvider.overrideWithValue(repo),
    ]);
    // The shell keeps the queue alive while the app runs.
    c.listen(actionQueueProvider, (_, _) {});
  });

  tearDown(() => c.dispose());

  QueuedAction step(String id, {String? localPhoto}) => QueuedAction.create(
        orderId: _order,
        action: localPhoto == null ? 'arrive_drop' : 'deliver',
        localPhoto: localPhoto,
        now: DateTime.utc(2026, 10, 22, 10),
      ).withId(id);

  test('A queues a step, B signs in: nothing is sent; A again: it is sent', () async {
    final queue = c.read(actionQueueProvider);
    repo.offline = true;
    final out = await queue.submit(step('tap-1'));
    expect(out.kind, ActionOutcomeKind.queued);
    expect(queue.current.single.uid, 'rider-a');

    // A signs out, B signs in; the signal is back.
    c.read(_uid.notifier).set(null);
    await _tick();
    c.read(_uid.notifier).set('rider-b');
    repo.offline = false;
    await _tick();
    await queue.flush();
    expect(repo.log, isEmpty, reason: "B's session never sends A's step");
    expect(queue.current, isEmpty, reason: "B's badge shows none of A's");
    expect(queue.all.single.actionId, 'tap-1', reason: 'kept on the phone for A');
    expect(prefs.getString(ActionQueue.key), contains('tap-1'));

    // A is back: the step goes, by itself.
    c.read(_uid.notifier).set('rider-a');
    await _tick();
    expect(repo.log, ['act:tap-1:null']);
    expect(queue.all, isEmpty);
  });

  test("A's kept proof photo stays on the phone under B and goes up with A", () async {
    final dir = Directory.systemTemp.createTempSync('queue-owner');
    addTearDown(() {
      try {
        dir.deleteSync(recursive: true);
      } on FileSystemException {
        // The queue deletes the sent photo itself, in the background.
      }
    });
    final photo = File('${dir.path}/proof.jpg')..writeAsBytesSync([0xFF, 0xD8, 0xFF, 1]);
    final queue = c.read(actionQueueProvider);
    repo.offline = true;
    await queue.submit(step('deliver-1', localPhoto: photo.path));

    c.read(_uid.notifier).set('rider-b');
    repo.offline = false;
    await _tick();
    await queue.flush();
    expect(repo.log, isEmpty);
    expect(photo.existsSync(), isTrue);

    c.read(_uid.notifier).set('rider-a');
    await _tick();
    await queue.flush();
    expect(repo.log, ['upload', 'act:deliver-1:$_order/server.jpg']);
    // Sent: the kept copy goes (in the background).
    final watch = Stopwatch()..start();
    while (photo.existsSync() && watch.elapsed < const Duration(seconds: 10)) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(photo.existsSync(), isFalse);
  });

  test("B signing in while A's proof photo uploads: the step is not sent under B", () async {
    final dir = Directory.systemTemp.createTempSync('queue-owner-up');
    addTearDown(() {
      try {
        dir.deleteSync(recursive: true);
      } on FileSystemException {
        // already gone
      }
    });
    final photo = File('${dir.path}/proof.jpg')..writeAsBytesSync([0xFF, 0xD8, 0xFF, 1]);
    final queue = c.read(actionQueueProvider);
    repo.offline = true;
    await queue.submit(step('deliver-1', localPhoto: photo.path));
    repo.offline = false;
    repo.uploadGate = Completer<void>();
    final flushing = queue.flush();
    await _tick();
    c.read(_uid.notifier).set('rider-b');
    await _tick();
    repo.uploadGate!.complete();
    repo.uploadGate = null;
    await flushing;
    await _tick();
    expect(repo.log, ['upload'], reason: "the action is not sent in B's session");
    final kept = queue.all.single;
    expect((kept.actionId, kept.uid, kept.photoPath), ('deliver-1', 'rider-a', '$_order/server.jpg'));
    expect(photo.existsSync(), isTrue);

    c.read(_uid.notifier).set('rider-a');
    await _tick();
    await queue.flush();
    expect(repo.log, ['upload', 'act:deliver-1:$_order/server.jpg'], reason: 'A sends it, with no second upload');
  });

  test("a refusal that comes back after B signed in does not drop A's step", () async {
    final queue = c.read(actionQueueProvider);
    repo.offline = true;
    await queue.submit(step('a-1'));
    repo.offline = false;
    repo.actGate = Completer<ActionOutcome>();
    final flushing = queue.flush();
    await _tick();
    c.read(_uid.notifier).set('rider-b');
    await _tick();
    // The server answers under B's session: not B's order.
    repo.actGate!.complete(ActionOutcome(ActionOutcomeKind.rejected, actionId: 'a-1', orderId: _order, code: 'forbidden'));
    repo.actGate = null;
    await flushing;
    expect(queue.all.single.actionId, 'a-1');
    expect(queue.all.single.uid, 'rider-a');
  });

  test('a step B taps is B\'s, and goes in B\'s session while A\'s waits', () async {
    final queue = c.read(actionQueueProvider);
    repo.offline = true;
    await queue.submit(step('a-1'));
    c.read(_uid.notifier).set('rider-b');
    await _tick();
    await queue.submit(step('b-1'));
    expect(queue.current.map((a) => a.actionId), ['b-1']);
    repo.offline = false;
    await queue.flush();
    expect(repo.log, ['act:b-1:null']);
    expect(queue.all.single.actionId, 'a-1');
  });

  group('a step saved by an earlier build (no owner)', () {
    String legacy() => jsonEncode([
          {'actionId': 'old-1', 'orderId': _order, 'action': 'pickup', 'queuedAt': '2026-10-22T10:00:00Z'},
        ]);

    test("is the kept delivery's rider's, not whoever is signed in", () async {
      await prefs.setString(ActionQueue.key, legacy());
      await prefs.setString(ActiveDeliveryCache.ownerKey, 'rider-a');
      c.read(_uid.notifier).set('rider-b');
      await _tick();
      c.invalidate(actionQueueProvider); // the app starts: the queue loads
      final queue = c.read(actionQueueProvider);
      await queue.flush();
      expect(repo.log, isEmpty, reason: "not sent in B's session");
      expect(queue.all.single.uid, 'rider-a');

      c.read(_uid.notifier).set('rider-a');
      await _tick();
      expect(repo.log, ['act:old-1:null']);
    });

    test('with no kept delivery it is the rider signed in when the queue loads', () async {
      await prefs.setString(ActionQueue.key, legacy());
      c.invalidate(actionQueueProvider); // the app starts: the queue loads
      final queue = c.read(actionQueueProvider);
      expect(queue.all.single.uid, 'rider-a');
      await _tick();
      expect(prefs.getString(ActionQueue.key), contains('"uid":"rider-a"'));
      repo.offline = true;
      await queue.flush();
      repo.offline = false;
      c.read(_uid.notifier).set('rider-b');
      await _tick();
      await queue.flush();
      expect(repo.log, isEmpty, reason: 'B signing in later does not get it');
    });

    test('a bare queue (no session to ask) sends it as before', () async {
      await prefs.setString(ActionQueue.key, legacy());
      final queue = ActionQueue(repo, prefs, ActiveDeliveryCache(prefs));
      await queue.flush();
      expect(repo.log, ['act:old-1:null']);
    });
  });

  test('flush is single-flight: asks while one is out share it', () async {
    final queue = c.read(actionQueueProvider);
    repo.offline = true;
    await queue.submit(step('tap-1'));
    repo.offline = false;
    final a = queue.flush();
    final b = queue.flush();
    expect(identical(a, b), isTrue);
    await a;
    expect(repo.log, ['act:tap-1:null']);
  });

  testWidgets('Settings warns before signing out with steps not sent', (tester) async {
    final queue = c.read(actionQueueProvider);
    repo.offline = true;
    await tester.runAsync(() async {
      await queue.submit(step('tap-1'));
      await queue.submit(step('tap-2'));
    });
    await tester.pumpWidget(UncontrolledProviderScope(
      container: c,
      child: MaterialApp(theme: buildTheme(Brightness.light), home: const SettingsScreen()),
    ));
    await tester.pump();
    final row = find.byKey(const Key('row-signout'));
    await tester.ensureVisible(row);
    await tester.pump();
    await tester.tap(row);
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.textContaining('You have 2 delivery steps not sent yet'), findsOneWidget);
    await tester.tap(find.byKey(const Key('confirm-cancel')));
    await tester.pump(const Duration(milliseconds: 400));
    expect(queue.all, hasLength(2));
    await tester.pumpWidget(const SizedBox());
  });

  group('the sign-out warning', () {
    test('says how many steps are waiting and that they stay on the phone', () {
      expect(signOutWarning(carrying: false, unsent: 0), 'Sign out anyway?');
      expect(signOutWarning(carrying: true, unsent: 0), "You're carrying an order. Sign out anyway?");
      expect(
        signOutWarning(carrying: false, unsent: 2),
        'You have 2 delivery steps not sent yet. If you sign out, they stay on this phone and '
        'Deligro gets them only when you sign in here again. Sign out anyway?',
      );
      expect(signOutWarning(carrying: true, unsent: 1), startsWith("You're carrying an order. You have 1 delivery step"));
    });
  });
}

extension on QueuedAction {
  QueuedAction withId(String id) => QueuedAction(
        actionId: id,
        orderId: orderId,
        action: action,
        localPhoto: localPhoto,
        queuedAt: queuedAt,
      );
}
