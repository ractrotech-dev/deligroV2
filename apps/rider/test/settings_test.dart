// Settings: which app Navigate opens, the alert sound and vibration switches,
// and the test alert. The switches are the ones the ring service reads
// (prefs ring_sound / ring_vibrate / nav_app), so persistence is checked
// against the stored file, not just the screen.
import 'package:deligro_rider/core/ring.dart';
import 'package:deligro_rider/features/settings/settings_screen.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeRing extends RingChannel {
  final started = <Map<String, Object?>>[];
  final opened = <String>[];

  @override
  Future<bool> start(
    String ringId, {
    required String title,
    required String body,
    int timeoutSec = 180,
    bool held = true,
  }) async {
    started.add({'ringId': ringId, 'title': title, 'body': body, 'timeoutSec': timeoutSec, 'held': held});
    return true;
  }

  @override
  Future<void> openSettings(String which) async => opened.add(which);
}

Future<({_FakeRing ring, SharedPreferences prefs})> _pump(
  WidgetTester tester, {
  Map<String, Object> stored = const {},
}) async {
  tester.view.physicalSize = const Size(360 * 3, 900 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues(stored);
  final prefs = await SharedPreferences.getInstance();
  final ring = _FakeRing();
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      ringChannelProvider.overrideWithValue(ring),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(theme: buildTheme(Brightness.light), home: const SettingsScreen()),
    ),
  );
  await tester.pump();
  return (ring: ring, prefs: prefs);
}

Future<void> _tap(WidgetTester tester, Key key) async {
  final f = find.byKey(key);
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await tester.pump();
}

bool _on(WidgetTester tester, Key key) => tester.widget<Switch>(find.byKey(key)).value;

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('navigation app', () {
    testWidgets('Google Maps is chosen until the rider picks another app', (tester) async {
      await _pump(tester);
      expect(find.text('Google Maps'), findsOneWidget);
      expect(find.text('Other app'), findsOneWidget);
      expect(find.byKey(const Key('nav-google-selected')), findsOneWidget);
      expect(find.byKey(const Key('nav-other-selected')), findsNothing);
    });

    testWidgets('choosing Other app is stored as nav_app and survives a restart', (tester) async {
      final h = await _pump(tester);
      await _tap(tester, const Key('row-nav-other'));
      expect(find.byKey(const Key('nav-other-selected')), findsOneWidget);
      expect(find.byKey(const Key('nav-google-selected')), findsNothing);
      expect(h.prefs.getString('nav_app'), 'other');
      expect(RiderPrefs(h.prefs).navApp, 'other');

      await _tap(tester, const Key('row-nav-google'));
      expect(h.prefs.getString('nav_app'), 'google');
    });

    testWidgets('a stored choice is shown on opening', (tester) async {
      await _pump(tester, stored: {'nav_app': 'other'});
      expect(find.byKey(const Key('nav-other-selected')), findsOneWidget);
    });
  });

  group('alert sound and vibration', () {
    testWidgets('both are on by default', (tester) async {
      await _pump(tester);
      expect(_on(tester, const Key('switch-sound')), isTrue);
      expect(_on(tester, const Key('switch-vibrate')), isTrue);
    });

    testWidgets('switching them off is stored as ring_sound and ring_vibrate', (tester) async {
      final h = await _pump(tester);
      await _tap(tester, const Key('switch-sound'));
      await _tap(tester, const Key('switch-vibrate'));
      expect(_on(tester, const Key('switch-sound')), isFalse);
      expect(_on(tester, const Key('switch-vibrate')), isFalse);
      expect(h.prefs.getBool('ring_sound'), isFalse);
      expect(h.prefs.getBool('ring_vibrate'), isFalse);
      final again = RiderPrefs(h.prefs);
      expect(again.ringSound, isFalse);
      expect(again.ringVibrate, isFalse);
    });

    testWidgets('a stored off is shown off', (tester) async {
      await _pump(tester, stored: {'ring_sound': false});
      expect(_on(tester, const Key('switch-sound')), isFalse);
      expect(_on(tester, const Key('switch-vibrate')), isTrue);
    });

    testWidgets('says that an order held for the rider still rings', (tester) async {
      await _pump(tester);
      expect(find.textContaining('held for you'), findsWidgets);
    });
  });

  group('test the alert', () {
    testWidgets('rings for 3 seconds, as a ring that follows the switches', (tester) async {
      final h = await _pump(tester);
      await _tap(tester, const Key('row-test-alert'));
      expect(h.ring.started, hasLength(1));
      final call = h.ring.started.single;
      expect(call['ringId'], testRingId);
      expect(call['timeoutSec'], 3);
      expect(call['held'], isFalse);
    });

    testWidgets('with sound off it still rings, so the phone only vibrates', (tester) async {
      final h = await _pump(tester, stored: {'ring_sound': false});
      await _tap(tester, const Key('row-test-alert'));
      expect(h.ring.started, hasLength(1));
      expect(h.ring.started.single['held'], isFalse);
      final out = RingOutput.resolve(held: false, soundOn: false, vibrateOn: true);
      expect(out.sound, isFalse);
      expect(out.vibrate, isTrue);
    });

    testWidgets('with both off it does not ring and says why', (tester) async {
      final h = await _pump(tester, stored: {'ring_sound': false, 'ring_vibrate': false});
      await _tap(tester, const Key('row-test-alert'));
      expect(h.ring.started, isEmpty);
      expect(find.textContaining('Turn on sound or vibration'), findsOneWidget);
    });
  });

  testWidgets('opens the phone\'s settings for the ring channel', (tester) async {
    final h = await _pump(tester);
    await _tap(tester, const Key('row-channel-settings'));
    expect(h.ring.opened, ['channel']);
  });
}
