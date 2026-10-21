import 'package:deligro_partner/core/ring.dart';
import 'package:deligro_partner/features/more/ring_setup.dart';
import 'package:deligro_partner/features/more/settings_screen.dart';
import 'package:deligro_partner/state/prefs.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support/fakes.dart';

class _MockRing extends Mock implements RingChannel {}

const _notReady = RingSetup(notifications: true, fullScreen: false, batteryUnrestricted: false, manufacturer: 'Xiaomi');
const _ready = RingSetup(notifications: true, fullScreen: true, batteryUnrestricted: true, manufacturer: 'Google');

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

  group('which orders ring', () {
    final placed = fakeOrder('aa11aa11-0000-0000-0000-000000000001');
    final accepted = fakeOrder('aa11aa11-0000-0000-0000-000000000001', status: 'kitchen');
    final other = fakeOrder('bb22bb22-0000-0000-0000-000000000002');

    test('a new order starts ringing under the server\'s ring id', () {
      final d = ringDiff({}, [placed]);
      expect(d.start, {'vendor:aa11aa11-0000-0000-0000-000000000001'});
      expect(d.stop, isEmpty);
    });

    test('an order that moved on stops ringing', () {
      final d = ringDiff({'vendor:aa11aa11-0000-0000-0000-000000000001'}, [accepted]);
      expect(d.start, isEmpty);
      expect(d.stop, {'vendor:aa11aa11-0000-0000-0000-000000000001'});
    });

    test('an order that left the board stops ringing; a ringing one is not restarted', () {
      final d = ringDiff({'vendor:aa11aa11-0000-0000-0000-000000000001'}, [other]);
      expect(d.start, {'vendor:bb22bb22-0000-0000-0000-000000000002'});
      expect(d.stop, {'vendor:aa11aa11-0000-0000-0000-000000000001'});
    });
  });

  test('the ringer starts, then stops, through the channel', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final ring = _MockRing();
    when(() => ring.start(any(), title: any(named: 'title'), body: any(named: 'body'), timeoutSec: any(named: 'timeoutSec')))
        .thenAnswer((_) async => true);
    when(() => ring.stop(any())).thenAnswer((_) async {});
    final c = ProviderContainer(overrides: [prefsProvider.overrideWithValue(prefs), ringChannelProvider.overrideWithValue(ring)]);
    addTearDown(c.dispose);
    final ringer = c.read(boardRingerProvider.notifier);
    String t(_) => 'New order';

    await ringer.sync([fakeOrder('aa11aa11-0000-0000-0000-000000000001')], title: t, body: t);
    verify(() => ring.start('vendor:aa11aa11-0000-0000-0000-000000000001', title: 'New order', body: 'New order', timeoutSec: 300)).called(1);

    // The next poll still shows it new: no second start.
    await ringer.sync([fakeOrder('aa11aa11-0000-0000-0000-000000000001')], title: t, body: t);
    verifyNever(() => ring.start(any(), title: any(named: 'title'), body: any(named: 'body'), timeoutSec: any(named: 'timeoutSec')));

    await ringer.sync([fakeOrder('aa11aa11-0000-0000-0000-000000000001', status: 'kitchen')], title: t, body: t);
    verify(() => ring.stop('vendor:aa11aa11-0000-0000-0000-000000000001')).called(1);
    expect(c.read(boardRingerProvider), isEmpty);
  });

  testPartner('settings lists what can stop the ring, with fixes', (t) async {
    final ring = _MockRing();
    when(ring.setup).thenAnswer((_) async => _notReady);
    when(() => ring.openSettings(any())).thenAnswer((_) async {});
    await pumpPartner(t, child: const SettingsScreen(), overrides: [ringChannelProvider.overrideWithValue(ring)]);
    await t.pumpAndSettle();
    expect(find.text('Full-screen alerts'), findsOneWidget);
    expect(find.text('Battery: unrestricted'), findsOneWidget);
    expect(find.text('Fix'), findsNWidgets(2));
    expect(find.text('Autostart (Xiaomi)'), findsOneWidget);
    await t.tap(find.text('Fix').last);
    verify(() => ring.openSettings('battery')).called(1);
  });

  testPartner('the orders banner shows only when the ring may fail', (t) async {
    final ring = _MockRing();
    when(ring.setup).thenAnswer((_) async => _notReady);
    await pumpPartner(t, child: const Scaffold(body: RingWarningBanner()), overrides: [ringChannelProvider.overrideWithValue(ring)]);
    await t.pumpAndSettle();
    expect(find.textContaining('may not ring'), findsOneWidget);
  });

  testPartner('no banner on a phone that is set up', (t) async {
    final ring = _MockRing();
    when(ring.setup).thenAnswer((_) async => _ready);
    await pumpPartner(t, child: const Scaffold(body: RingWarningBanner()), overrides: [ringChannelProvider.overrideWithValue(ring)]);
    await t.pumpAndSettle();
    expect(find.textContaining('may not ring'), findsNothing);
  });
}
