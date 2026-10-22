// The ring: the server's start/stop payloads (src/lib/alerts/ring.ts), the
// "a stop remembered, an older start ignored" rule, which rings the switches
// may silence, and what the open board rings for. RingService.kt carries the
// same rules on the phone; the last group checks the two still name the same
// things.
import 'dart:io';

import 'package:deligro_rider/core/ring.dart';
import 'package:deligro_rider/models/jobs.dart';
import 'package:deligro_rider/state/clock.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _order = '3f2a9c1e-0000-4000-8000-000000000001';

class _FakeRing extends RingChannel {
  final calls = <String>[];
  final started = <Map<String, Object?>>[];

  @override
  Future<bool> start(
    String ringId, {
    required String title,
    required String body,
    int timeoutSec = 180,
    bool held = true,
  }) async {
    calls.add('start $ringId');
    started.add({'ringId': ringId, 'title': title, 'body': body, 'timeoutSec': timeoutSec, 'held': held});
    return true;
  }

  @override
  Future<void> stop(String ringId) async => calls.add('stop $ringId');
}

RiderOffer _offer(String id, {bool held = true, DateTime? expires}) => RiderOffer(
      orderId: id,
      code: 'DL-1',
      shop: const RiderStop(name: 'Sharma Sweets', line: 'Main Road'),
      drop: const RiderStop(name: 'Customer', line: 'Ward 7'),
      reservedForYou: held,
      offerExpiresAt: expires,
      payment: const RiderPayment(instruction: CashInstruction.prepaid),
    );

void main() {
  group('payload', () {
    test('a start carries the ring id, the timeout and the server time', () {
      final m = parseRingMessage({'ring': 'start', 'ringId': 'rider:$_order', 'timeoutSec': 90, 'sentAt': 1700000000000});
      expect(m, isA<RingStart>());
      final s = m as RingStart;
      expect(s.ringId, 'rider:$_order');
      expect(s.timeoutSec, 90);
      expect(s.sentAt, 1700000000000);
    });

    test('a stop carries the ring id and the server time', () {
      final m = parseRingMessage({'ring': 'stop', 'ringId': 'rider:$_order', 'sentAt': 1700000005000});
      expect(m, isA<RingStop>());
      expect(m!.ringId, 'rider:$_order');
      expect(m.sentAt, 1700000005000);
    });

    test('the timeout is the push\'s own, clamped to 1..600 s, 180 when absent', () {
      RingStart start(Object? t) =>
          parseRingMessage({'ring': 'start', 'ringId': 'r', 'timeoutSec': t, 'sentAt': 1}) as RingStart;
      expect(start(45).timeoutSec, 45);
      expect(start(0).timeoutSec, 1);
      expect(start(9999).timeoutSec, 600);
      expect(start('120').timeoutSec, 120);
      expect(start(null).timeoutSec, 180);
      expect(start('soon').timeoutSec, 180);
    });

    test('numbers that arrive as doubles or strings are read', () {
      final m = parseRingMessage({'ring': 'stop', 'ringId': 'r', 'sentAt': '1700000005000'});
      expect(m!.sentAt, 1700000005000);
      final d = parseRingMessage({'ring': 'stop', 'ringId': 'r', 'sentAt': 1.7e12});
      expect(d!.sentAt, 1700000000000);
    });

    test('held is true unless the server says false, and a stop has none', () {
      RingStart start(Object? held) => parseRingMessage(
          {'ring': 'start', 'ringId': 'r', 'timeoutSec': 60, 'sentAt': 1, 'held': ?held}) as RingStart;
      expect(start(null).held, isTrue);
      expect(start(true).held, isTrue);
      expect(start(false).held, isFalse);
      expect(start('false').held, isFalse);
      expect(start('true').held, isTrue);
    });

    test('anything that is not a ring is left alone', () {
      expect(parseRingMessage(null), isNull);
      expect(parseRingMessage({}), isNull);
      expect(parseRingMessage({'url': '/orders/1'}), isNull);
      expect(parseRingMessage({'ring': 'start'}), isNull, reason: 'no ring id');
      expect(parseRingMessage({'ring': 'start', 'ringId': ''}), isNull);
      expect(parseRingMessage({'ring': 'wobble', 'ringId': 'r'}), isNull);
    });

    test('the rider ring id is the server\'s', () {
      expect(riderRingId(_order), 'rider:$_order');
    });
  });

  group('a stop is remembered', () {
    test('a start sent before the stop is ignored', () {
      final ledger = RingLedger(now: () => DateTime.utc(2026, 10, 21, 10));
      ledger.rememberStop(const RingStop('rider:a', 2000));
      expect(ledger.shouldRing(const RingStart('rider:a', 180, 1000)), isFalse);
      expect(ledger.shouldRing(const RingStart('rider:a', 180, 2000)), isFalse, reason: 'same instant counts as before');
    });

    test('a later re-offer to the same rider rings normally', () {
      final ledger = RingLedger(now: () => DateTime.utc(2026, 10, 21, 10));
      ledger.rememberStop(const RingStop('rider:a', 2000));
      expect(ledger.shouldRing(const RingStart('rider:a', 180, 3000)), isTrue);
    });

    test('a stop for one order does not silence another', () {
      final ledger = RingLedger(now: () => DateTime.utc(2026, 10, 21, 10));
      ledger.rememberStop(const RingStop('rider:a', 2000));
      expect(ledger.shouldRing(const RingStart('rider:b', 180, 1000)), isTrue);
    });

    test('a start with no server time (sentAt 0, from the open board) always rings', () {
      final ledger = RingLedger(now: () => DateTime.utc(2026, 10, 21, 10));
      ledger.rememberStop(const RingStop('rider:a', 2000));
      expect(ledger.shouldRing(const RingStart('rider:a', 180, 0)), isTrue);
    });

    test('a stop made on this phone (sentAt 0) is not remembered', () {
      final ledger = RingLedger(now: () => DateTime.utc(2026, 10, 21, 10));
      ledger.rememberStop(const RingStop('rider:a', 0));
      expect(ledger.shouldRing(const RingStart('rider:a', 180, 1000)), isTrue);
    });

    test('the memory fades after 15 minutes and is pruned', () {
      var t = DateTime.utc(2026, 10, 21, 10);
      final ledger = RingLedger(now: () => t);
      ledger.rememberStop(const RingStop('rider:a', 2000));
      t = t.add(const Duration(minutes: 14));
      expect(ledger.shouldRing(const RingStart('rider:a', 180, 1000)), isFalse);
      t = t.add(const Duration(minutes: 2));
      expect(ledger.shouldRing(const RingStart('rider:a', 180, 1000)), isTrue);
      ledger.rememberStop(const RingStop('rider:b', 2000));
      expect(ledger.length, 1, reason: 'the expired entry was dropped');
    });

    test('a stop never moves an older stop backwards', () {
      final ledger = RingLedger(now: () => DateTime.utc(2026, 10, 21, 10));
      ledger.rememberStop(const RingStop('rider:a', 5000));
      ledger.rememberStop(const RingStop('rider:a', 3000));
      expect(ledger.shouldRing(const RingStart('rider:a', 180, 4000)), isFalse);
    });
  });

  group('which rings the switches may silence', () {
    test('an offer held for this rider rings even with both switches off', () {
      final out = RingOutput.resolve(held: true, soundOn: false, vibrateOn: false);
      expect(out.sound, isTrue);
      expect(out.vibrate, isTrue);
      expect(out.silent, isFalse);
    });

    test('a ring that is not held follows the switches', () {
      expect(RingOutput.resolve(held: false, soundOn: false, vibrateOn: true).sound, isFalse);
      expect(RingOutput.resolve(held: false, soundOn: false, vibrateOn: true).vibrate, isTrue);
      expect(RingOutput.resolve(held: false, soundOn: true, vibrateOn: false).vibrate, isFalse);
      expect(RingOutput.resolve(held: false, soundOn: false, vibrateOn: false).silent, isTrue);
      expect(RingOutput.resolve(held: false, soundOn: true, vibrateOn: true).silent, isFalse);
    });

    test('RiderPrefs: both switches default on and are stored under the keys the phone reads', () async {
      SharedPreferences.setMockInitialValues({});
      final prefs = RiderPrefs(await SharedPreferences.getInstance());
      expect(prefs.ringSound, isTrue);
      expect(prefs.ringVibrate, isTrue);
      await prefs.setRingSound(false);
      await prefs.setRingVibrate(false);
      expect(prefs.ringSound, isFalse);
      expect(prefs.ringVibrate, isFalse);
      final raw = await SharedPreferences.getInstance();
      expect(raw.getBool('ring_sound'), isFalse);
      expect(raw.getBool('ring_vibrate'), isFalse);
    });
  });

  group('the open board rings for offers held for this rider', () {
    late _FakeRing ring;
    late DateTime now;
    late ProviderContainer c;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      ring = _FakeRing();
      now = DateTime.utc(2026, 10, 21, 10);
      c = ProviderContainer(overrides: [
        prefsProvider.overrideWithValue(prefs),
        ringChannelProvider.overrideWithValue(ring),
        clockProvider.overrideWithValue(() => now),
      ]);
      addTearDown(c.dispose);
    });

    RiderBoard board(List<RiderOffer> offers) => RiderBoard(offers: offers);

    test('starts once under the server\'s ring id, for the time left', () async {
      final ringer = c.read(boardRingerProvider.notifier);
      final held = _offer(_order, expires: now.add(const Duration(seconds: 150)));
      await ringer.sync(board([held]));
      await ringer.sync(board([held]));
      expect(ring.calls, ['start rider:$_order']);
      expect(ring.started.single['timeoutSec'], 150);
      expect(ring.started.single['held'], isTrue);
    });

    test('an offer nobody holds, or one past its window, does not ring', () async {
      final ringer = c.read(boardRingerProvider.notifier);
      await ringer.sync(board([
        _offer('open', held: false),
        _offer('late', expires: now.subtract(const Duration(seconds: 1))),
      ]));
      expect(ring.calls, isEmpty);
    });

    test('stops when the offer leaves the board', () async {
      final ringer = c.read(boardRingerProvider.notifier);
      await ringer.sync(board([_offer(_order, expires: now.add(const Duration(minutes: 2)))]));
      await ringer.sync(board([]));
      expect(ring.calls, ['start rider:$_order', 'stop rider:$_order']);
    });

    test('an offer the rider answered is not started again by a board that still lists it', () async {
      final ringer = c.read(boardRingerProvider.notifier);
      final held = _offer(_order, expires: now.add(const Duration(minutes: 2)));
      await ringer.sync(board([held]));
      await ringer.answered(_order);
      await ringer.sync(board([held]));
      expect(ring.calls, ['start rider:$_order', 'stop rider:$_order']);
    });

    test('counts the window on the server clock when the phone clock is wrong', () async {
      final server = now;
      now = server.add(const Duration(minutes: 3)); // the phone runs 3 minutes fast
      c.read(serverOffsetProvider.notifier).set(server.difference(now));
      final ringer = c.read(boardRingerProvider.notifier);
      await ringer.sync(board([_offer(_order, expires: server.add(const Duration(seconds: 150)))]));
      expect(ring.calls, ['start rider:$_order']);
      expect(ring.started.single['timeoutSec'], 150);
    });

    test('stopAll stops every ring', () async {
      final ringer = c.read(boardRingerProvider.notifier);
      await ringer.sync(board([_offer(_order, expires: now.add(const Duration(minutes: 2)))]));
      await ringer.stopAll();
      expect(ring.calls.last, 'stop *');
      expect(c.read(boardRingerProvider), isEmpty);
    });
  });

  group('the app and the phone agree', () {
    final service = File('android/app/src/main/kotlin/com/ractrotech/deligro/rider/RingService.kt').readAsStringSync();
    final extension =
        File('android/app/src/main/kotlin/com/ractrotech/deligro/rider/RingNotificationExtension.kt').readAsStringSync();
    final manifest = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();

    test('RingService uses the channel, the missed channel and the stop memory named here', () {
      expect(service, contains('"$ringChannelId"'));
      expect(service, contains('"$ringMissedChannelId"'));
      expect(service, contains('"$ringStoppedPrefs"'));
      expect(service, contains('USAGE_ALARM'));
    });

    test('the extension reads the payload keys the server sends', () {
      for (final key in ringPayloadKeys) {
        expect(extension, contains('"$key"'), reason: key);
      }
      expect(extension, contains('"start"'));
      expect(extension, contains('"stop"'));
    });

    test('the extension reads held, and the app names the same key', () {
      expect(extension, contains('"$ringHeldKey"'));
    });

    test('a MediaPlayer that fails to prepare or start is released, not leaked', () {
      final start = service.substring(service.indexOf('private fun startSound()'), service.indexOf('private fun startVibration()'));
      final handler = start.substring(start.indexOf('catch (e: Exception)'));
      expect(handler, contains('release()'));
    });

    test('the test alert leaves no "order still waiting" notice, and the channel settings can be opened', () {
      expect(service, contains('"$testRingId"'));
      final main = File('android/app/src/main/kotlin/com/ractrotech/deligro/rider/MainActivity.kt').readAsStringSync();
      expect(main, contains('ACTION_CHANNEL_NOTIFICATION_SETTINGS'));
      expect(main, contains('"channel"'));
    });

    test('the phone reads the same two switches the app writes', () {
      expect(service, contains('"flutter.${RiderPrefs.ringSoundKey}"'));
      expect(service, contains('"flutter.${RiderPrefs.ringVibrateKey}"'));
    });

    test('the manifest declares the service, the extension and the permissions a ring needs', () {
      expect(manifest, contains('android:name=".RingService"'));
      expect(manifest, contains('com.onesignal.NotificationServiceExtension'));
      expect(manifest, contains('com.ractrotech.deligro.rider.RingNotificationExtension'));
      expect(manifest, contains('android.permission.USE_FULL_SCREEN_INTENT'));
      expect(manifest, contains('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK'));
      expect(manifest, contains('android.permission.VIBRATE'));
    });

    test('the ring sound exists', () {
      final raw = Directory('android/app/src/main/res/raw').listSync().map((f) => f.uri.pathSegments.last);
      expect(raw.any((n) => n.startsWith('deligro_ring.')), isTrue);
    });
  });
}
