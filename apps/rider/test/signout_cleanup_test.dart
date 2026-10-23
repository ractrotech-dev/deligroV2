// Signing out clears what the rider left on the phone (C-I3): the delivery
// kept for no signal, proof photos no saved step needs, and what sharing and
// printing left in the cache. A photo a saved step still carries stays (the
// step is kept for its rider, I-3). At start, stray proof photos are swept.
import 'dart:convert';
import 'dart:io';

import 'package:deligro_rider/core/action_queue.dart';
import 'package:deligro_rider/core/active_cache.dart';
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/sos_queue.dart';
import 'package:deligro_rider/data/jobs_repository.dart';
import 'package:deligro_rider/data/safety_repository.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/state/safety.dart' show safetyRepoProvider;
import 'package:deligro_rider/state/user_data.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Uid extends Notifier<String?> {
  @override
  String? build() => 'rider-a';
  void set(String? v) => state = v;
}

final _uid = NotifierProvider<_Uid, String?>(_Uid.new);

/// No signal for SOS: an alert stays waiting.
class _Sos implements SafetyRepository {
  @override
  dynamic noSuchMethod(Invocation i) => Future<Never>.error(ApiException(0, 'network'));
}

class _NoJobs implements JobsRepository {
  @override
  dynamic noSuchMethod(Invocation i) => throw UnimplementedError('${i.memberName}');
}

/// Waits for real file I/O to land, a little at a time.
Future<void> _until(bool Function() done) async {
  final watch = Stopwatch()..start();
  while (!done()) {
    if (watch.elapsed > const Duration(seconds: 10)) fail('timed out');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  late Directory root;
  late Directory documents;
  late Directory cache;

  setUp(() {
    root = Directory.systemTemp.createTempSync('signout-clean');
    documents = Directory('${root.path}/documents')..createSync();
    cache = Directory('${root.path}/cache')..createSync();
  });

  tearDown(() {
    try {
      root.deleteSync(recursive: true);
    } on FileSystemException {
      // A clean-up still finishing in the background got there first.
    }
  });

  File file(String path) => File('${root.path}/$path')
    ..createSync(recursive: true)
    ..writeAsStringSync('x');

  Future<ProviderContainer> container(Map<String, Object> prefs) async {
    SharedPreferences.setMockInitialValues(prefs);
    final c = ProviderContainer(overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      userIdProvider.overrideWith((ref) => ref.watch(_uid)),
      jobsRepoProvider.overrideWithValue(_NoJobs()),
      safetyRepoProvider.overrideWithValue(_Sos()),
      appDirsProvider.overrideWithValue(Future.value((documents: documents, cache: cache))),
    ]);
    addTearDown(c.dispose);
    return c;
  }

  String queued(String photo) => jsonEncode([
        {
          'actionId': 'deliver-1',
          'orderId': 'o-1',
          'action': 'deliver',
          'localPhoto': photo,
          'uid': 'rider-a',
          'queuedAt': '2026-10-22T10:00:00Z',
        },
      ]);

  test('sign-out: the kept delivery, stray proof photos and share/print leftovers go', () async {
    final kept = file('documents/proof/o-1-kept.jpg');
    final stray = file('documents/proof/o-2-old.jpg');
    final shared = file('cache/share_plus/statement.csv');
    final printed = file('cache/share/statement.pdf');
    final uuid = file('cache/0b7f1c9e-3a2d-4e5f-8a9b-0c1d2e3f4a5b/statement.csv');
    final raster = file('cache/printing123.pdf');
    final picked = file('cache/image_picker_ABC.jpg');
    final other = file('cache/flutter_engine/keep.bin');

    final c = await container({
      ActionQueue.key: queued(kept.path),
      ActiveDeliveryCache.key: '{"orderId":"o-1"}',
      ActiveDeliveryCache.ownerKey: 'rider-a',
    });
    c.listen(userDataGuardProvider, (_, _) {});
    // The stray one is not swept at start only if it is still needed: it is
    // not, so the start sweep already takes it.
    await _until(() => !stray.existsSync());
    expect(kept.existsSync(), isTrue);

    c.read(_uid.notifier).set(null);
    await _until(() => [shared, printed, uuid, raster, picked].every((f) => !f.existsSync()));
    await _until(() => c.read(prefsProvider).getString(ActiveDeliveryCache.key) == null);
    final prefs = c.read(prefsProvider);
    expect(prefs.getString(ActiveDeliveryCache.key), isNull);
    expect(prefs.getString(ActiveDeliveryCache.ownerKey), isNull);
    expect(kept.existsSync(), isTrue, reason: "A's saved step still needs its photo");
    expect(printed.existsSync(), isFalse);
    expect(uuid.existsSync(), isFalse);
    expect(raster.existsSync(), isFalse);
    expect(other.existsSync(), isTrue, reason: 'only what sharing and printing left');
    expect(prefs.getString(ActionQueue.key), contains('deliver-1'), reason: 'the step is kept for A');
  });

  test("an SOS alert waiting at sign-out is dropped even if nothing ever listened to the queue (P7-R3)", () async {
    final now = DateTime.now().toUtc().toIso8601String();
    final c = await container({
      SosQueue.key: jsonEncode([
        {'id': 's-1', 'uid': 'rider-a', 'queuedAt': now},
      ]),
    });
    // A cold start into Jobs: Home (which watches the SOS status) never built.
    c.listen(userDataGuardProvider, (_, _) {});
    final prefs = c.read(prefsProvider);
    c.read(_uid.notifier).set(null);
    await _until(() => !(prefs.getString(SosQueue.key) ?? '').contains('s-1'));
    // A signs back in: nothing of the old alert is sent.
    c.read(_uid.notifier).set('rider-a');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(prefs.getString(SosQueue.key) ?? '', isNot(contains('s-1')));
  });

  test('at start, proof photos no saved step needs are swept', () async {
    final stray = file('documents/proof/o-9-old.jpg');
    final c = await container({});
    c.listen(userDataGuardProvider, (_, _) {});
    await _until(() => !stray.existsSync());
  });

  test('sweepProofPhotos keeps exactly the photos asked for', () async {
    final a = file('documents/proof/a.jpg');
    final b = file('documents/proof/b.jpg');
    await sweepProofPhotos(documents, [a.path]);
    expect(a.existsSync(), isTrue);
    expect(b.existsSync(), isFalse);
  });
}
