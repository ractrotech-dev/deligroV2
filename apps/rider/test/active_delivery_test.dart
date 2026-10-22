// The active delivery screen: one primary action per status, the pickup and
// delivery panels (code, QR, proof photo), calls, navigation, the exception
// sheets, the timeline, and the copy kept on the phone for a lost signal.
// No network, no camera: the jobs backend is the fixture repository behind a
// recorder, and the scanner, the camera, the URL launcher and the routing
// server are the test's own.
import 'dart:convert';
import 'dart:io';

import 'package:deligro_rider/core/active_cache.dart';
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/location_service.dart';
import 'package:deligro_rider/core/navigation_launcher.dart';
import 'package:deligro_rider/core/ring.dart';
import 'package:deligro_rider/core/routing.dart';
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/data/jobs_repository.dart';
import 'package:deligro_rider/features/delivery/active_delivery_screen.dart';
import 'package:deligro_rider/features/delivery/proof_photo.dart';
import 'package:deligro_rider/features/delivery/qr_scan_screen.dart';
import 'package:deligro_rider/features/delivery/route_map.dart';
import 'package:deligro_rider/features/jobs/jobs_screen.dart';
import 'package:deligro_rider/models/jobs.dart';
import 'package:deligro_rider/models/queued_action.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/clock.dart';
import 'package:deligro_rider/state/jobs.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

final _uuidV4 = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

/// The fixture shop and drop (fixture_data.dart).
const _shopPoint = (lat: 21.7189, lng: 81.5301);
const _dropPoint = (lat: 21.7102, lng: 81.5398);

class _Clock {
  _Clock(this.now);
  DateTime now;
  DateTime call() => now;
  void advance(Duration d) => now = now.add(d);
}

class _QuietRing extends RingChannel {
  @override
  Future<bool> start(String ringId,
          {required String title, required String body, int timeoutSec = 180, bool held = true}) async =>
      true;

  @override
  Future<void> stop(String ringId) async {}
}

/// The fixture backend, with every call written down and any of them made to
/// fail on demand.
class _Repo implements JobsRepository {
  _Repo(this.scenario, this.now) : inner = FixtureJobsRepository.create(scenario: scenario, now: now);

  final String scenario;
  final DateTime now;

  /// Timeline events the board carries on top of the fixture's (the server
  /// writes a `note` when the customer changes the instructions).
  List<Map<String, dynamic>> extraTimeline = const [];

  final FixtureJobsRepository inner;
  final acts = <QueuedAction>[];
  final contacts = <String>[];
  final uploads = <String>[];
  final raised = <Map<String, Object?>>[];
  Object? boardError;

  /// The server's clock for the board's `serverNow`; null = the board has none.
  DateTime Function()? serverNow;
  Object? actError;
  Object? raiseError;
  Object? contactError;
  Object? uploadError;

  /// Uploads and steps in the order they reached the server.
  final log = <String>[];

  /// Every step is answered "this order is not yours any more".
  bool gone = false;

  /// The board no longer lists the delivery (ops cancelled it: the real board
  /// lists only assigned and picked-up orders).
  bool dropActive = false;

  @override
  Future<RiderBoard> board() async {
    final e = boardError;
    if (e != null) throw e;
    if (extraTimeline.isNotEmpty) {
      final m = FixtureData.board(scenario, now: now);
      final active = m['active'] as Map<String, dynamic>;
      active['timeline'] = [...(active['timeline'] as List), ...extraTimeline];
      return RiderBoard.fromJson(m);
    }
    final b = await inner.board();
    final clock = serverNow?.call();
    if (dropActive) return RiderBoard(offers: b.offers, upcoming: b.upcoming, serverNow: clock);
    if (clock == null) return b;
    return RiderBoard(
      offers: b.offers,
      upcoming: b.upcoming,
      active: b.active,
      offerWindowSeconds: b.offerWindowSeconds,
      routingBaseUrl: b.routingBaseUrl,
      serverNow: clock,
    );
  }

  @override
  Future<void> accept(String orderId) => inner.accept(orderId);

  @override
  Future<void> reject(String orderId, String reason, {String? note}) => inner.reject(orderId, reason, note: note);

  @override
  Future<ActionOutcome> act(QueuedAction a) async {
    acts.add(a);
    final e = actError;
    if (e != null) throw e;
    log.add('act:${a.action}');
    if (gone) {
      return ActionOutcome(ActionOutcomeKind.orderGone,
          actionId: a.actionId, orderId: a.orderId, code: 'order_not_active');
    }
    return inner.act(a);
  }

  @override
  Future<String> uploadProof(String orderId, File photo) async {
    uploads.add(photo.path);
    final e = uploadError;
    if (e != null) throw e;
    log.add('upload');
    return inner.uploadProof(orderId, photo);
  }

  @override
  Future<void> logContact(String orderId, String target) async {
    contacts.add(target);
    final e = contactError;
    if (e != null) throw e;
    await inner.logContact(orderId, target);
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
    raised.add({'kind': kind, 'reason': reason, 'notes': notes, 'photoPath': photoPath});
    final e = raiseError;
    if (e != null) throw e;
    return inner.raiseException(
        orderId: orderId, kind: kind, reason: reason, notes: notes, photoPath: photoPath, lat: lat, lng: lng);
  }
}

class _H {
  _H(this.repo, this.clock, this.container, this.opened, this.kept);
  final _Repo repo;

  /// Proof photos copied to the phone's documents for a saved deliver.
  final List<String> kept;
  final _Clock clock;
  final ProviderContainer container;
  final List<Uri> opened;

  void fix(({double lat, double lng}) p) =>
      container.read(latestFixProvider.notifier).set((lat: p.lat, lng: p.lng, at: clock.now));
}

Future<_H> _pump(
  WidgetTester tester, {
  String scenario = 'accepted',
  _Repo? repo,
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  Map<String, Object> prefs = const {},
  Set<String> installed = const {'google.navigation', 'geo', 'https', 'tel'},
  Future<String?> Function(BuildContext)? scan,
  Future<File?> Function()? takePhoto,
  http.Client? routing,
  ({double lat, double lng})? fix,

  /// How far ahead of the server the phone's clock runs.
  Duration phoneAhead = Duration.zero,
}) async {
  tester.view.physicalSize = const Size(360 * 3, 760 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues(prefs);
  final serverStart = DateTime.utc(2026, 10, 22, 10);
  final clock = _Clock(serverStart.add(phoneAhead));
  final r = repo ?? _Repo(scenario, serverStart);
  if (phoneAhead != Duration.zero) r.serverNow = () => clock.now.subtract(phoneAhead);
  final opened = <Uri>[];
  final kept = <String>[];
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      jobsRepoProvider.overrideWithValue(r),
      clockProvider.overrideWithValue(clock.call),
      ringChannelProvider.overrideWithValue(_QuietRing()),
      meProvider.overrideWith((_) async => RiderMe(
            id: 'rider-1',
            name: 'Ravi Kumar',
            availability: RiderAvailabilityDto(isOnline: true, onlineSince: clock.now, lastFixAt: clock.now),
            phase: 'online',
          )),
      mapTilesEnabledProvider.overrideWithValue(false),
      routingClientProvider.overrideWithValue(RoutingClient(
        client: routing ?? MockClient((_) async => http.Response('down', 503)),
      )),
      urlOpenerProvider.overrideWithValue((uri) async {
        opened.add(uri);
        return installed.contains(uri.scheme);
      }),
      qrScannerProvider.overrideWithValue(scan ?? (_) async => null),
      photoTakerProvider.overrideWithValue(takePhoto ?? () async => File('test/support/proof.jpg')),
      proofKeeperProvider.overrideWithValue((orderId, photo) async {
        final path = 'kept/$orderId-${kept.length}.jpg';
        kept.add(path);
        return path;
      }),
    ],
  );
  addTearDown(container.dispose);
  final h = _H(r, clock, container, opened, kept);
  if (fix != null) h.fix(fix);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      // A fresh tree every pump: a sheet left open by an earlier pump in the
      // same test must not sit over this one.
      key: UniqueKey(),
      container: container,
      child: MaterialApp(
        theme: buildTheme(brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
          child: child!,
        ),
        home: const JobsScreen(),
      ),
    ),
  );
  await _settle(tester);
  return h;
}

/// Lets futures finish. Not pumpAndSettle: the Jobs tab's clock never settles.
Future<void> _settle(WidgetTester tester, {int rounds = 8}) async {
  for (var i = 0; i < rounds; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
    await tester.pump(const Duration(milliseconds: 20));
  }
}

Future<void> _tap(WidgetTester tester, Finder f) async {
  await tester.ensureVisible(f);
  await tester.pump();
  await tester.tap(f);
  await _settle(tester);
  await tester.pump(const Duration(milliseconds: 400)); // sheets slide in
  await _settle(tester, rounds: 3);
}

/// Closes the sheet on top. Not a tap on the barrier: with the test font a
/// sheet can fill the whole screen.
Future<void> _closeSheet(WidgetTester tester) async {
  tester.state<NavigatorState>(find.byType(Navigator).first).pop();
  await _settle(tester);
  await tester.pump(const Duration(milliseconds: 400));
  await _settle(tester, rounds: 2);
}

Future<void> _typeCode(WidgetTester tester, String code) async {
  await tester.enterText(find.byKey(const Key('code-field')), code);
  await _settle(tester);
  await tester.pump(const Duration(milliseconds: 400));
  await _settle(tester, rounds: 3);
}

final _primary = find.byKey(const Key('primary-action'));

String _primaryText(WidgetTester tester) {
  final texts = tester.widgetList<Text>(find.descendant(of: _primary, matching: find.byType(Text)));
  return texts.map((t) => t.data ?? '').join(' ');
}

bool _enabled(WidgetTester tester, Finder f) {
  final w = tester.widget(f);
  if (w is ButtonStyleButton) return w.onPressed != null;
  if (w is ListTile) return w.enabled && w.onTap != null;
  throw StateError('not a button: $w');
}

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('each status has its one primary action', () {
    for (final (scenario, label) in [
      ('accepted', "I've arrived at the shop"),
      ('arrived_pickup', 'Enter pickup code'),
      ('picked_up', 'Start trip'),
      ('on_the_way', "I've arrived"),
      ('arrived_drop', 'Enter delivery code'),
      ('delivered', 'Back to jobs'),
      ('failed', 'Back to jobs'),
      ('cancelled', 'Back to jobs'),
    ]) {
      testWidgets('$scenario: $label', (tester) async {
        await _pump(tester, scenario: scenario);
        expect(find.byKey(const Key('active-delivery')), findsOneWidget);
        expect(_primary, findsOneWidget);
        expect(_primaryText(tester), label);
      });
    }

    testWidgets('the step tracker lists all nine statuses and marks the current one', (tester) async {
      await _pump(tester, scenario: 'picked_up');
      for (final label in [
        'Assigned',
        'Accepted',
        'Arrived at pickup',
        'Picked up',
        'On the way',
        'Arrived at customer',
        'Delivered',
        'Failed',
        'Cancelled',
      ]) {
        expect(find.descendant(of: find.byKey(const Key('step-tracker')), matching: find.text(label)), findsOneWidget,
            reason: label);
      }
      expect(find.byKey(const Key('step-current-picked_up')), findsOneWidget);
    });

    testWidgets('the card: code, shop and drop with calls, instructions, items, cash, distance', (tester) async {
      await _pump(tester, scenario: 'on_the_way');
      final card = find.byKey(const Key('active-delivery'));
      Finder has(String t) => find.descendant(of: card, matching: find.textContaining(t));
      expect(has('DL-4810'), findsWidgets);
      expect(has('Sharma Sweets and Snacks'), findsWidgets);
      expect(has('Main Road, Bemetara'), findsWidgets);
      expect(has('Anita Verma'), findsWidgets);
      expect(has('Ward 7, near the water tank'), findsWidgets);
      expect(has('Leave with the guard if the gate is locked'), findsOneWidget);
      expect(has('Paneer butter masala'), findsOneWidget);
      expect(has('× 4'), findsOneWidget);
      expect(has('Collect ₹485'), findsOneWidget);
      expect(find.byKey(const Key('call-shop')), findsOneWidget);
      expect(find.byKey(const Key('call-customer')), findsOneWidget);
      expect(find.byKey(const Key('navigate')), findsOneWidget);
    });

    testWidgets('a terminal status says what happened', (tester) async {
      await _pump(tester, scenario: 'failed');
      expect(find.text('Delivery failed'), findsOneWidget);
      expect(find.textContaining('back to the shop'), findsOneWidget);
      await _pump(tester, scenario: 'cancelled');
      expect(find.text('Order cancelled'), findsOneWidget);
      await _pump(tester, scenario: 'delivered');
      expect(find.text('Delivered'), findsWidgets);
    });
  });

  group('steps go through the action queue', () {
    testWidgets('arrive at the shop: a fresh v4 UUID and the latest fix', (tester) async {
      final h = await _pump(tester, scenario: 'accepted', fix: (lat: 21.7180, lng: 81.5300));
      await _tap(tester, _primary);
      final a = h.repo.acts.single;
      expect(a.action, 'arrive_pickup');
      expect(a.actionId, matches(_uuidV4));
      expect(a.lat, 21.7180);
      expect(a.lng, 81.5300);
      expect(_primaryText(tester), 'Enter pickup code');
    });

    testWidgets('start the trip, then arrive at the customer', (tester) async {
      final h = await _pump(tester, scenario: 'picked_up');
      await _tap(tester, _primary);
      expect(h.repo.acts.last.action, 'start_trip');
      expect(_primaryText(tester), "I've arrived");
      await _tap(tester, _primary);
      expect(h.repo.acts.last.action, 'arrive_drop');
      expect(_primaryText(tester), 'Enter delivery code');
      expect(h.repo.acts.map((a) => a.actionId).toSet(), hasLength(2), reason: 'one id per tap');
    });

    testWidgets('no signal: saved, the screen moves on, and it says so', (tester) async {
      final h = await _pump(tester, scenario: 'picked_up');
      h.repo.actError = ApiException(0, 'network');
      await _tap(tester, _primary);
      expect(find.text('Saved — will send when you\'re back online'), findsOneWidget);
      expect(_primaryText(tester), "I've arrived", reason: 'the queued step counts on screen');
      expect(h.container.read(actionQueueProvider).current.single.action, 'start_trip');
    });

    testWidgets('delivered with no signal: shown as not sent yet, then delivered once it goes', (tester) async {
      final h = await _pump(tester, scenario: 'arrived_drop');
      await _tap(tester, find.byKey(const Key('proof-photo')));
      h.repo.actError = ApiException(0, 'network');
      await _tap(tester, _primary);
      await _typeCode(tester, fixtureCode);
      expect(find.text('Delivered — not sent yet'), findsOneWidget);
      expect(find.byKey(const Key('pending-steps')), findsOneWidget);

      h.repo.actError = null;
      await h.container.read(actionQueueProvider).flush();
      await _settle(tester);
      expect(find.text('Delivered — not sent yet'), findsNothing);
      expect(find.text('Delivered'), findsWidgets);
      expect(h.repo.acts.last.photoPath, isNotNull);
    });

    testWidgets('the order is gone: the screen says so and offers the way back', (tester) async {
      final now = DateTime.utc(2026, 10, 22, 10);
      final repo = _Repo('on_the_way', now)..gone = true;
      await _pump(tester, repo: repo);
      await _tap(tester, _primary);
      expect(find.textContaining('no longer yours'), findsOneWidget);
      expect(_primaryText(tester), 'Back to jobs');
    });

    testWidgets('a cancelled fixture answers order_not_active (the gone notice is reachable)', (tester) async {
      final now = DateTime.utc(2026, 10, 22, 10);
      final repo = FixtureJobsRepository.create(scenario: 'cancelled', now: now);
      final out = await repo.act(QueuedAction.create(orderId: 'f1000000-0000-4000-8000-000000000001', action: 'deliver'));
      expect(out.kind, ActionOutcomeKind.orderGone);
      expect(out.code, 'order_not_active');
    });
  });

  group('Task 7 review fixes', () {
    testWidgets('ops cancel while a step is saved offline: the board drops it, the rider still sees why',
        (tester) async {
      final h = await _pump(tester, scenario: 'on_the_way');
      h.repo.actError = ApiException(0, 'network');
      await _tap(tester, _primary); // arrive_drop, saved
      expect(h.container.read(actionQueueProvider).current.single.action, 'arrive_drop');

      // The board stops listing it; the step still can't be sent.
      h.repo.dropActive = true;
      await h.container.read(boardProvider.notifier).refresh();
      await _settle(tester);
      expect(find.byKey(const Key('active-delivery')), findsOneWidget, reason: 'held until the step is answered');
      expect(_primaryText(tester), 'Enter delivery code');

      // The signal is back: the step is refused, the order is gone.
      h.repo
        ..actError = null
        ..gone = true;
      await h.container.read(boardProvider.notifier).refresh();
      await _settle(tester);
      expect(find.textContaining('no longer yours'), findsOneWidget);
      expect(_primaryText(tester), 'Back to jobs');
      expect(h.container.read(actionQueueProvider).current, isEmpty);
    });

    testWidgets('a deliver saved offline that goes through after the board dropped the order: Delivered',
        (tester) async {
      final h = await _pump(tester, scenario: 'arrived_drop');
      await _tap(tester, find.byKey(const Key('proof-photo')));
      h.repo.actError = ApiException(0, 'network');
      await _tap(tester, _primary);
      await _typeCode(tester, fixtureCode);
      expect(find.text('Delivered — not sent yet'), findsOneWidget);

      h.repo
        ..actError = null
        ..dropActive = true;
      await h.container.read(boardProvider.notifier).refresh();
      await _settle(tester);
      expect(find.text('Delivered — not sent yet'), findsNothing);
      expect(find.text('Delivered'), findsWidgets);
      expect(_primaryText(tester), 'Back to jobs');
    });

    testWidgets('no signal for the photo or the code: saved with the photo, sent photo first when back',
        (tester) async {
      final h = await _pump(tester, scenario: 'arrived_drop');
      h.repo
        ..uploadError = ApiException(0, 'network')
        ..actError = ApiException(0, 'network');
      await _tap(tester, find.byKey(const Key('proof-photo')));
      expect(find.text("Photo not sent — it'll retry"), findsOneWidget);
      expect(_enabled(tester, find.descendant(of: _primary, matching: find.byWidgetPredicate((w) => w is ButtonStyleButton))),
          isTrue, reason: 'the code can be entered with the photo still on the phone');

      await _tap(tester, _primary);
      await _typeCode(tester, fixtureCode);
      expect(find.text('Delivered — not sent yet'), findsOneWidget);
      final saved = h.container.read(actionQueueProvider).current.single;
      expect((saved.action, saved.code, saved.photoPath), ('deliver', fixtureCode, null));
      expect(saved.localPhoto, h.kept.single);

      h.repo
        ..uploadError = null
        ..actError = null;
      await h.container.read(actionQueueProvider).flush();
      await _settle(tester);
      expect(h.repo.log, ['upload', 'act:deliver']);
      expect(h.repo.acts.last.photoPath, isNotNull);
      expect(find.text('Delivered'), findsWidgets);
      expect(find.text('Delivered — not sent yet'), findsNothing);
    });

    testWidgets('a photo that did not go retries by itself when the board answers again', (tester) async {
      final h = await _pump(tester, scenario: 'arrived_drop');
      h.repo.uploadError = ApiException(0, 'network');
      await _tap(tester, find.byKey(const Key('proof-photo')));
      expect(find.text("Photo not sent — it'll retry"), findsOneWidget);

      h.repo.uploadError = null;
      await h.container.read(boardProvider.notifier).refresh();
      await _settle(tester);
      expect(find.byKey(const Key('proof-photo-attached')), findsOneWidget);
    });

    testWidgets('a photo the server will not take asks for a retake', (tester) async {
      final h = await _pump(tester, scenario: 'arrived_drop');
      h.repo.uploadError = ApiException(400, 'too_large');
      await _tap(tester, find.byKey(const Key('proof-photo')));
      expect(find.textContaining("couldn't be used"), findsOneWidget);
      expect(find.byKey(const Key('proof-photo')), findsOneWidget, reason: 'back to Take proof photo');
    });

    testWidgets('two taps in one frame send one step', (tester) async {
      final h = await _pump(tester, scenario: 'picked_up');
      // Both taps land before anything else runs, as two touches in one
      // frame do on a phone.
      final button = tester.widget<ButtonStyleButton>(
          find.descendant(of: _primary, matching: find.byWidgetPredicate((w) => w is ButtonStyleButton)));
      button.onPressed!();
      button.onPressed!();
      await _settle(tester);
      expect(h.repo.acts, hasLength(1));
    });
  });

  group('pickup', () {
    testWidgets('the panel: code, QR, the shop can hand over, manual check', (tester) async {
      await _pump(tester, scenario: 'arrived_pickup');
      expect(find.byKey(const Key('scan-qr')), findsOneWidget);
      expect(find.textContaining('Handed to rider'), findsOneWidget);
      expect(find.byKey(const Key('handover-spinner')), findsOneWidget);
      expect(find.byKey(const Key('manual-check')), findsOneWidget);
    });

    testWidgets('a wrong code: the error, and the boxes clear; the right one picks up', (tester) async {
      final h = await _pump(tester, scenario: 'arrived_pickup');
      await _tap(tester, _primary);
      await _typeCode(tester, '9999');
      expect(find.byKey(const Key('code-error')), findsOneWidget);
      expect(find.text('Wrong code. Check it with the shop and try again.'), findsOneWidget);
      final field = tester.widget<TextField>(find.byKey(const Key('code-field')));
      expect(field.controller!.text, isEmpty);
      expect(h.repo.acts.last.code, '9999');
      expect(h.repo.acts.last.method, 'code');

      await _typeCode(tester, fixtureCode);
      expect(find.byKey(const Key('code-field')), findsNothing, reason: 'the sheet closed');
      expect(h.repo.acts.last.action, 'pickup');
      expect(_primaryText(tester), 'Start trip');
    });

    testWidgets('a scanned QR fills the code and submits it with method qr', (tester) async {
      final h = await _pump(tester, scenario: 'arrived_pickup', scan: (_) async => fixtureCode);
      await _tap(tester, find.byKey(const Key('scan-qr')));
      final a = h.repo.acts.single;
      expect(a.action, 'pickup');
      expect(a.code, fixtureCode);
      expect(a.method, 'qr');
      expect(_primaryText(tester), 'Start trip');
    });

    testWidgets('a scan that comes back empty sends nothing', (tester) async {
      final h = await _pump(tester, scenario: 'arrived_pickup', scan: (_) async => null);
      await _tap(tester, find.byKey(const Key('scan-qr')));
      expect(h.repo.acts, isEmpty);
    });

    testWidgets('Request manual check raises manual_pickup with the reason chosen', (tester) async {
      final h = await _pump(tester, scenario: 'arrived_pickup');
      await _tap(tester, find.byKey(const Key('manual-check')));
      expect(_enabled(tester, find.byKey(const Key('issue-send'))), isFalse, reason: 'no reason yet');
      await _tap(tester, find.byKey(const Key('issue-reason-0')));
      await _tap(tester, find.byKey(const Key('issue-send')));
      expect(h.repo.raised.single['kind'], 'manual_pickup');
      expect(find.textContaining('Sent to ops'), findsOneWidget);
      expect(find.textContaining('Waiting for ops'), findsOneWidget, reason: 'the pending request shows on the card');
    });
  });

  group('delivery', () {
    testWidgets('a photo-required delivery blocks the code until a photo is attached', (tester) async {
      final h = await _pump(tester, scenario: 'arrived_drop');
      expect(_primaryText(tester), 'Enter delivery code');
      expect(_enabled(tester, find.descendant(of: _primary, matching: find.byWidgetPredicate((w) => w is ButtonStyleButton))),
          isFalse);
      await _tap(tester, find.byKey(const Key('proof-photo')));
      expect(find.byKey(const Key('proof-photo-attached')), findsOneWidget);
      expect(_enabled(tester, find.descendant(of: _primary, matching: find.byWidgetPredicate((w) => w is ButtonStyleButton))),
          isTrue);
      expect(h.repo.uploads, ['test/support/proof.jpg']);

      await _tap(tester, _primary);
      await _typeCode(tester, fixtureCode);
      final a = h.repo.acts.single;
      expect(a.action, 'deliver');
      expect(a.code, fixtureCode);
      expect(a.photoPath, isNotNull);
      expect(find.text('Delivered'), findsWidgets);
      expect(_primaryText(tester), 'Back to jobs');
    });

    testWidgets('a wrong delivery code says so', (tester) async {
      await _pump(tester, scenario: 'arrived_drop');
      await _tap(tester, find.byKey(const Key('proof-photo')));
      await _tap(tester, _primary);
      await _typeCode(tester, '0000');
      expect(find.text('Wrong code. Ask the customer for their 4-digit code.'), findsOneWidget);
    });

    testWidgets('customer unreachable waits for a call and the wait, and says which', (tester) async {
      final h = await _pump(tester, scenario: 'arrived_drop'); // arrived 9 of 10 minutes ago
      final row = find.byKey(const Key('issue-customer_unreachable'));

      await _tap(tester, find.byKey(const Key('cant-deliver')));
      expect(_enabled(tester, row), isFalse);
      expect(find.textContaining('Call the customer first'), findsOneWidget);
      await _closeSheet(tester);

      await _tap(tester, find.byKey(const Key('call-customer')));
      expect(h.repo.contacts, ['customer']);
      expect(h.opened.last, Uri.parse('tel:+919800000002'));

      await _tap(tester, find.byKey(const Key('cant-deliver')));
      expect(_enabled(tester, row), isFalse);
      expect(find.textContaining('1:00'), findsOneWidget, reason: 'the wait left, counting down');

      h.clock.advance(const Duration(seconds: 61));
      await tester.pump(const Duration(seconds: 1));
      await _settle(tester);
      expect(_enabled(tester, row), isTrue);

      await _tap(tester, row);
      await _tap(tester, find.byKey(const Key('issue-reason-0')));
      await tester.enterText(find.byKey(const Key('issue-notes')), 'Rang the bell too');
      await _tap(tester, find.byKey(const Key('issue-send')));
      expect(h.repo.raised.single['kind'], 'customer_unreachable');
      expect(h.repo.raised.single['notes'], 'Rang the bell too');
    });

    testWidgets('the unreachable wait is counted on the server clock, on a phone 3 minutes fast', (tester) async {
      final h = await _pump(tester, scenario: 'arrived_drop', phoneAhead: const Duration(minutes: 3));
      final row = find.byKey(const Key('issue-customer_unreachable'));
      await _tap(tester, find.byKey(const Key('call-customer')));
      await _tap(tester, find.byKey(const Key('cant-deliver')));
      // Arrived 9 of 10 minutes ago on the server: 1:00 left, not "already over".
      expect(_enabled(tester, row), isFalse);
      expect(find.textContaining('1:00'), findsOneWidget);
      await _closeSheet(tester);

      h.clock.advance(const Duration(seconds: 61));
      await tester.pump(const Duration(seconds: 1));
      await _settle(tester);
      await _tap(tester, find.byKey(const Key('cant-deliver')));
      expect(_enabled(tester, row), isTrue);
    });

    testWidgets('a call is placed even when logging it fails', (tester) async {
      final h = await _pump(tester, scenario: 'on_the_way');
      h.repo.contactError = ApiException(0, 'network');
      await _tap(tester, find.byKey(const Key('call-shop')));
      expect(h.repo.contacts, ['vendor']);
      expect(h.opened.single, Uri.parse('tel:+919800000001'));
    });

    testWidgets('the server refusing a request explains it (wait_longer)', (tester) async {
      final h = await _pump(tester, scenario: 'arrived_drop');
      await _tap(tester, find.byKey(const Key('cant-deliver')));
      await _tap(tester, find.byKey(const Key('issue-wrong_address')));
      await _tap(tester, find.byKey(const Key('issue-reason-0')));
      h.repo.raiseError = ApiException(409, 'wait_longer', body: {'minutesLeft': 4});
      await _tap(tester, find.byKey(const Key('issue-send')));
      expect(find.textContaining('4 more min'), findsOneWidget);
    });

    testWidgets('ops_approved refused as bad_state reads "Ops haven\'t approved this yet"', (tester) async {
      expect(actionErrorText('bad_state', method: 'ops_approved'), "Ops haven't approved this yet");
      expect(actionErrorText('photo_required'), contains('photo'));
      expect(actionErrorText('manual_not_approved'), contains('approved'));
    });

    testWidgets('go offline / hand back only before the pickup', (tester) async {
      await _pump(tester, scenario: 'accepted');
      await _tap(tester, find.byKey(const Key('report-problem')));
      expect(find.byKey(const Key('issue-go_offline')), findsOneWidget);
      expect(find.byKey(const Key('issue-missing_items')), findsOneWidget);
      expect(find.byKey(const Key('issue-wrong_package')), findsOneWidget);
      expect(find.byKey(const Key('issue-vendor_delay')), findsOneWidget);
      expect(find.byKey(const Key('issue-other_issue')), findsOneWidget);

      await _pump(tester, scenario: 'arrived_drop');
      await _tap(tester, find.byKey(const Key('cant-deliver')));
      expect(find.byKey(const Key('issue-go_offline')), findsNothing);
      expect(find.byKey(const Key('issue-wrong_address')), findsOneWidget);
      expect(find.byKey(const Key('issue-complete_without_code')), findsOneWidget);
      expect(find.byKey(const Key('issue-failed_delivery')), findsOneWidget);
    });
  });

  group('navigation', () {
    test('Google Maps turn-by-turn, then the web; other apps through geo:', () {
      expect(navigationUris(NavApp.google, point: _dropPoint).map((u) => u.toString()), [
        'google.navigation:q=21.7102,81.5398&mode=d',
        'https://www.google.com/maps/dir/?api=1&destination=21.7102,81.5398',
      ]);
      expect(navigationUris(NavApp.other, point: _dropPoint).first.toString(), 'geo:21.7102,81.5398?q=21.7102,81.5398');
      final byAddress = navigationUris(NavApp.google, address: 'Ward 7, Bemetara');
      expect(byAddress.first.toString(), 'google.navigation:q=Ward%207%2C%20Bemetara&mode=d');
      expect(navigationUris(NavApp.other, address: 'Ward 7').first.toString(), 'geo:0,0?q=Ward%207');
      expect(NavApp.parse(null), NavApp.google);
      expect(NavApp.parse('other'), NavApp.other);
    });

    testWidgets('Navigate opens the shop in Google Maps by default', (tester) async {
      final h = await _pump(tester, scenario: 'accepted');
      await _tap(tester, find.byKey(const Key('navigate')));
      expect(h.opened.single.toString(), 'google.navigation:q=21.7189,81.5301&mode=d');
    });

    testWidgets('no Google Maps: the web directions', (tester) async {
      final h = await _pump(tester, scenario: 'on_the_way', installed: const {'https'});
      await _tap(tester, find.byKey(const Key('navigate')));
      expect(h.opened.map((u) => u.scheme), ['google.navigation', 'https']);
      expect(h.opened.last.queryParameters['destination'], '21.7102,81.5398');
    });

    testWidgets('"Other app" in settings: geo:', (tester) async {
      final h = await _pump(tester, scenario: 'on_the_way', prefs: {RiderPrefs.navAppKey: 'other'});
      await _tap(tester, find.byKey(const Key('navigate')));
      expect(h.opened.single.toString(), 'geo:21.7102,81.5398?q=21.7102,81.5398');
    });
  });

  group('map and arrival', () {
    testWidgets('no routing server: a straight line and an ETA marked approx.', (tester) async {
      await _pump(tester, scenario: 'on_the_way', fix: (lat: 21.7150, lng: 81.5350));
      expect(find.byKey(const Key('route-map')), findsOneWidget);
      expect(find.textContaining('approx.'), findsWidgets);
    });

    testWidgets('a routed ETA from the routing server is not approx.', (tester) async {
      final routing = MockClient((_) async => http.Response(
            jsonEncode({
              'code': 'Ok',
              'routes': [
                {
                  'geometry': {
                    'coordinates': [
                      [81.5350, 21.7150],
                      [81.5398, 21.7102],
                    ],
                  },
                  'distance': 900,
                  'duration': 240,
                },
              ],
            }),
            200,
          ));
      await _pump(tester, scenario: 'on_the_way', fix: (lat: 21.7150, lng: 81.5350), routing: routing);
      expect(find.textContaining('4 min'), findsWidgets);
      expect(find.textContaining('approx.'), findsNothing);
    });

    testWidgets('inside 150 m of the stop the arrival button pulses and a banner suggests it, once', (tester) async {
      final h = await _pump(tester, scenario: 'on_the_way', fix: (lat: 21.7150, lng: 81.5350));
      expect(find.byKey(const Key('near-banner')), findsNothing);
      expect(find.byKey(const Key('primary-pulse')), findsNothing);

      h.fix((lat: 21.7108, lng: 81.5396)); // about 70 m from the drop
      await _settle(tester);
      expect(find.byKey(const Key('near-banner')), findsOneWidget);
      expect(find.byKey(const Key('primary-pulse')), findsOneWidget);

      await _tap(tester, find.byKey(const Key('near-banner-close')));
      expect(find.byKey(const Key('near-banner')), findsNothing);
      h.fix((lat: 21.7104, lng: 81.5397));
      await _settle(tester);
      expect(find.byKey(const Key('near-banner')), findsNothing, reason: 'one time only');
      expect(find.byKey(const Key('primary-pulse')), findsOneWidget);
    });
  });

  group('SOS and changed instructions', () {
    testWidgets('the header has an SOS button', (tester) async {
      await _pump(tester, scenario: 'on_the_way');
      expect(find.byKey(const Key('sos-button')), findsOneWidget);
      expect(find.text('SOS'), findsOneWidget);
    });

    testWidgets('instructions the customer changed are highlighted', (tester) async {
      final clock = DateTime.utc(2026, 10, 22, 10);
      final repo = _Repo('on_the_way', clock)
        ..extraTimeline = [
          {'kind': 'note', 'method': 'instructions_changed', 'reason': null, 'at': clock.toIso8601String()},
        ];
      await _pump(tester, repo: repo);
      expect(find.byKey(const Key('instructions-updated')), findsWidgets);
      expect(find.text('Customer changed these'), findsWidgets);
    });

    testWidgets('instructions nobody changed are not highlighted', (tester) async {
      await _pump(tester, scenario: 'on_the_way');
      expect(find.byKey(const Key('instructions-updated')), findsNothing);
    });
  });

  group('timeline and requests', () {
    testWidgets('the timeline sheet lists the delivery events', (tester) async {
      await _pump(tester, scenario: 'on_the_way');
      await _tap(tester, find.byKey(const Key('timeline-button')));
      final sheet = find.byKey(const Key('timeline-sheet'));
      expect(sheet, findsOneWidget);
      for (final t in ['Accepted', 'Arrived at the shop', 'Picked up with the code', 'Started the trip']) {
        expect(find.descendant(of: sheet, matching: find.text(t)), findsOneWidget, reason: t);
      }
    });

    testWidgets('pending and decided requests show on the card with ops notes', (tester) async {
      await _pump(tester, scenario: 'exceptions');
      expect(find.textContaining('Waiting for ops'), findsOneWidget);
      expect(find.textContaining('Approved'), findsOneWidget);
      expect(find.textContaining('Checked with the shop'), findsOneWidget);
      expect(find.textContaining('Not approved'), findsOneWidget);
      expect(find.textContaining('Wait at the drop and try again'), findsOneWidget);
    });
  });

  group('no signal', () {
    testWidgets('the delivery kept on the phone renders, with the offline banner', (tester) async {
      final now = DateTime.utc(2026, 10, 22, 10);
      final repo = _Repo('idle', now)..boardError = ApiException(0, 'network');
      final kept = RiderActive.fromJson(FixtureData.active('on_the_way', now: now));
      await _pump(tester, repo: repo, prefs: {ActiveDeliveryCache.key: jsonEncode(kept.toJson())});
      expect(find.byKey(const Key('active-delivery')), findsOneWidget);
      expect(find.text('Offline — showing saved details'), findsOneWidget);
      expect(_primaryText(tester), "I've arrived");
      expect(find.textContaining('Anita Verma'), findsWidgets);
    });
  });

  group('looks', () {
    for (final (name, brightness, scale) in [
      ('light', Brightness.light, 1.0),
      ('dark', Brightness.dark, 1.0),
      ('light at 1.3x text', Brightness.light, 1.3),
      ('dark at 1.3x text', Brightness.dark, 1.3),
    ]) {
      testWidgets('every status renders without overflow: $name', (tester) async {
        for (final scenario in [
          'accepted',
          'arrived_pickup',
          'picked_up',
          'on_the_way',
          'arrived_drop',
          'delivered',
          'failed',
          'cancelled',
          'exceptions',
        ]) {
          await _pump(tester, scenario: scenario, brightness: brightness, textScale: scale, fix: _shopPoint);
          expect(tester.takeException(), isNull, reason: scenario);
          await tester.drag(find.byKey(const Key('delivery-scroll')), const Offset(0, -2000));
          await _settle(tester, rounds: 2);
          expect(tester.takeException(), isNull, reason: '$scenario scrolled');
        }
      });

      testWidgets('sheets render without overflow: $name', (tester) async {
        await _pump(tester, scenario: 'arrived_drop', brightness: brightness, textScale: scale);
        await _tap(tester, find.byKey(const Key('cant-deliver')));
        expect(tester.takeException(), isNull);
        await _tap(tester, find.byKey(const Key('issue-complete_without_code')));
        expect(tester.takeException(), isNull);
        await _closeSheet(tester);
        await _tap(tester, find.byKey(const Key('proof-photo')));
        await _tap(tester, _primary);
        expect(find.byKey(const Key('code-field')), findsOneWidget);
        expect(tester.takeException(), isNull);
        await _closeSheet(tester);
        await _tap(tester, find.byKey(const Key('timeline-button')));
        expect(tester.takeException(), isNull);
      });
    }
  });
}
