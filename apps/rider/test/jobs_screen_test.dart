// The Jobs tab: offers with a countdown, accept, reject with a reason, the
// offline empty state, polling, and the ring ending when the rider answers.
// No network: the jobs repository is a fake (or the fixture backend), the clock
// is the test's own.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:deligro_rider/core/active_cache.dart';
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/ring.dart';
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/data/jobs_repository.dart';
import 'package:deligro_rider/features/jobs/jobs_screen.dart';
import 'package:deligro_rider/features/jobs/offer_errors.dart';
import 'package:deligro_rider/models/jobs.dart';
import 'package:deligro_rider/models/queued_action.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/clock.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _held = 'f1000000-0000-4000-8000-000000000002';
const _open = 'f1000000-0000-4000-8000-000000000003';
const _upcoming = 'f1000000-0000-4000-8000-000000000004';

/// A clock the test moves by hand.
class _Clock {
  _Clock(this.now);
  DateTime now;
  DateTime call() => now;
  void advance(Duration d) => now = now.add(d);
}

class _FakeRing extends RingChannel {
  final calls = <String>[];

  @override
  Future<bool> start(
    String ringId, {
    required String title,
    required String body,
    int timeoutSec = 180,
    bool held = true,
  }) async {
    calls.add('start $ringId');
    return true;
  }

  @override
  Future<void> stop(String ringId) async => calls.add('stop $ringId');
}

/// Serves a board the test can change, and records what the screen asks for.
class _FakeJobs implements JobsRepository {
  _FakeJobs(this.current);

  RiderBoard current;
  Object? boardError;
  Object? acceptError;
  Object? rejectError;
  int boardCalls = 0;
  final accepted = <String>[];
  final rejected = <({String id, String reason, String? note})>[];

  /// What the board becomes when an accept succeeds.
  RiderBoard Function(String orderId)? afterAccept;
  Completer<void>? holdAccept;

  @override
  Future<RiderBoard> board() async {
    boardCalls++;
    final e = boardError;
    if (e != null) throw e;
    return current;
  }

  @override
  Future<void> accept(String orderId) async {
    accepted.add(orderId);
    await holdAccept?.future;
    final e = acceptError;
    if (e != null) throw e;
    current = afterAccept?.call(orderId) ?? current;
  }

  @override
  Future<void> reject(String orderId, String reason, {String? note}) async {
    rejected.add((id: orderId, reason: reason, note: note));
    final e = rejectError;
    if (e != null) throw e;
    current = RiderBoard(
      offers: current.offers.where((o) => o.orderId != orderId).toList(),
      upcoming: current.upcoming,
      offerWindowSeconds: current.offerWindowSeconds,
    );
  }

  @override
  Future<ActionOutcome> act(QueuedAction a) async => throw UnimplementedError();
  @override
  Future<String> uploadProof(String orderId, File photo) async => throw UnimplementedError();
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
  }) async =>
      throw UnimplementedError();
}

RiderOffer _offer(
  String id, {
  required String code,
  required String shop,
  bool held = false,
  DateTime? expires,
  RiderPayment payment = const RiderPayment(instruction: CashInstruction.prepaid),
  double? earning,
  String? instructions,
}) =>
    RiderOffer(
      orderId: id,
      code: code,
      shop: RiderStop(name: shop, line: 'Main Road, Bemetara'),
      drop: const RiderStop(name: 'Customer', line: 'Ward 7, near the water tank'),
      instructions: instructions,
      itemCount: 4,
      shopToDropKm: 2.6,
      riderToShopKm: 0.8,
      etaMinutes: 16,
      offerExpiresAt: expires,
      reservedForYou: held,
      payment: payment,
      estimatedEarning: earning,
    );

RiderActive _active() => RiderActive(
      orderId: _held,
      deliveryId: 'd1',
      code: 'DL-4821',
      status: RiderDeliveryStatus.accepted,
      shop: const RiderStop(name: 'Sharma Sweets and Snacks', line: 'Main Road, Bemetara'),
      drop: const RiderDrop(name: 'Customer', line: 'Ward 7, near the water tank'),
      payment: const RiderPayment(instruction: CashInstruction.collect, collectAmount: 485),
    );

RiderMe _me({bool online = true}) => RiderMe(
      id: 'rider-1',
      name: 'Ravi Kumar',
      availability: RiderAvailabilityDto(
        isOnline: online,
        onlineSince: online ? DateTime.now() : null,
        lastFixAt: online ? DateTime.now() : null,
      ),
      phase: online ? 'online' : 'offline',
    );

class _Harness {
  _Harness(this.jobs, this.clock, this.ring, this.container);
  final _FakeJobs jobs;
  final _Clock clock;
  final _FakeRing ring;
  final ProviderContainer container;
}

Future<_Harness> _pump(
  WidgetTester tester, {
  required _FakeJobs jobs,
  _Clock? clock,
  bool online = true,
  Brightness brightness = Brightness.light,
  double textScale = 1.0,
  Map<String, Object> prefs = const {},
  JobsRepository? repo,
  bool routed = false,
}) async {
  tester.view.physicalSize = const Size(360 * 3, 720 * 3);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues(prefs);
  final clk = clock ?? _Clock(DateTime.utc(2026, 10, 21, 10));
  final ring = _FakeRing();
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      jobsRepoProvider.overrideWithValue(repo ?? jobs),
      clockProvider.overrideWithValue(clk.call),
      ringChannelProvider.overrideWithValue(ring),
      meProvider.overrideWith((_) async => _me(online: online)),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: routed
          ? MaterialApp.router(
              theme: buildTheme(brightness),
              routerConfig: GoRouter(
                routes: [
                  GoRoute(path: '/', builder: (_, _) => const JobsScreen()),
                  GoRoute(
                    path: '/more/profile/documents',
                    builder: (_, _) => const Scaffold(body: Text('documents page')),
                  ),
                ],
              ),
            )
          : MaterialApp(
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
  return _Harness(jobs, clk, ring, container);
}

/// Lets futures finish. Not pumpAndSettle: the countdown never settles.
Future<void> _settle(WidgetTester tester, {int rounds = 6}) async {
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
  // Sheets slide in over a quarter of a second.
  await tester.pump(const Duration(milliseconds: 400));
}

/// One second of wall time passing: the clock and the widget's timer together.
Future<void> _tick(WidgetTester tester, _Clock clock, [int seconds = 1]) async {
  for (var i = 0; i < seconds; i++) {
    clock.advance(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
  }
}

RiderBoard _offers(_Clock clock, {double? earning, int heldSeconds = 179}) => RiderBoard(
      offers: [
        _offer(
          _held,
          code: 'DL-4821',
          shop: 'Sharma Sweets and Snacks',
          held: true,
          expires: clock.now.add(Duration(seconds: heldSeconds)),
          payment: const RiderPayment(instruction: CashInstruction.collect, collectAmount: 485),
          earning: earning,
          instructions: 'Ring the bell twice',
        ),
        _offer(_open, code: 'DL-4822', shop: 'Annapurna Kitchen'),
      ],
      upcoming: [
        RiderUpcoming(
          offer: _offer(_upcoming, code: 'DL-4823', shop: 'Bake House'),
          readyInMinutes: 7,
        ),
      ],
    );

final _accept = find.byKey(const Key('accept-$_held'));
final _reject = find.byKey(const Key('reject-$_held'));

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  group('the first offer is a large card', () {
    testWidgets('shows the shop, both lines, instructions, figures, cash and who holds it', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      await _pump(tester, jobs: _FakeJobs(_offers(clock)), clock: clock);

      final card = find.byKey(const Key('offer-card-$_held'));
      expect(card, findsOneWidget);
      Finder inCard(String t) => find.descendant(of: card, matching: find.textContaining(t));
      expect(inCard('Sharma Sweets and Snacks'), findsOneWidget);
      expect(inCard('Main Road, Bemetara'), findsOneWidget);
      expect(inCard('Ward 7, near the water tank'), findsOneWidget);
      expect(inCard('Ring the bell twice'), findsOneWidget);
      expect(inCard('4 items'), findsOneWidget);
      expect(inCard('2.6 km'), findsOneWidget);
      expect(inCard('0.8 km'), findsOneWidget);
      expect(inCard('16 min'), findsOneWidget);
      expect(inCard('Collect ₹485'), findsOneWidget);
      expect(inCard('Held for you'), findsOneWidget);
      expect(inCard('DL-4821'), findsOneWidget);
    });

    testWidgets('a prepaid order says Prepaid; an unconfirmed one does not demand cash', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final board = RiderBoard(offers: [
        _offer(_held, code: 'DL-1', shop: 'Prepaid Shop', held: true, expires: clock.now.add(const Duration(minutes: 2))),
        _offer(_open, code: 'DL-2', shop: 'Unsure Shop',
            payment: const RiderPayment(instruction: CashInstruction.unconfirmed)),
      ]);
      await _pump(tester, jobs: _FakeJobs(board), clock: clock);
      expect(find.text('Paid online'), findsOneWidget);
      expect(find.textContaining('Collect'), findsNothing);
      expect(find.textContaining('Payment not confirmed'), findsOneWidget);
    });

    testWidgets('no estimated earning is ever shown: riders are on a salary', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      await _pump(tester, jobs: _FakeJobs(_offers(clock, earning: 60)), clock: clock);
      expect(find.textContaining('Estimated earning'), findsNothing);
      expect(find.textContaining('est.'), findsNothing);
      expect(find.textContaining('₹60'), findsNothing);
    });

    testWidgets('the rest are compact rows with their own Accept', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      await _pump(tester, jobs: _FakeJobs(_offers(clock)), clock: clock);
      expect(find.byKey(const Key('offer-card-$_open')), findsNothing);
      final row = find.byKey(const Key('offer-row-$_open'));
      await tester.scrollUntilVisible(row, 200);
      expect(row, findsOneWidget);
      expect(find.descendant(of: row, matching: find.textContaining('Annapurna Kitchen')), findsOneWidget);
      expect(find.descendant(of: row, matching: find.textContaining('Open to everyone')), findsOneWidget);
      expect(find.byKey(const Key('accept-$_open')), findsOneWidget);
      // Only the offer held for this rider can be turned down.
      expect(find.byKey(const Key('reject-$_open')), findsNothing);
    });

    testWidgets('upcoming pickups say when they are ready', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      await _pump(tester, jobs: _FakeJobs(_offers(clock)), clock: clock);
      await tester.scrollUntilVisible(find.textContaining('Bake House'), 200);
      expect(find.text('Upcoming pickups'), findsOneWidget);
      expect(find.textContaining('ready in ~7 min'), findsOneWidget);
    });
  });

  group('the countdown', () {
    testWidgets('a phone clock 3 minutes fast still shows 2:59 for a fresh offer', (tester) async {
      final server = DateTime.utc(2026, 10, 21, 10);
      final clock = _Clock(server.add(const Duration(minutes: 3)));
      final board = RiderBoard(
        serverNow: server,
        offers: [_offer(_held, code: 'DL-4821', shop: 'Sharma Sweets', held: true, expires: server.add(const Duration(seconds: 179)))],
      );
      await _pump(tester, jobs: _FakeJobs(board), clock: clock);

      final countdown = find.byKey(const Key('countdown-$_held'));
      expect(find.descendant(of: countdown, matching: find.text('2:59')), findsOneWidget);
      await _tick(tester, clock, 1);
      expect(find.descendant(of: countdown, matching: find.text('2:58')), findsOneWidget);
    });

    testWidgets('a server time days away from the phone is ignored, not trusted', (tester) async {
      final phone = DateTime.utc(2026, 10, 21, 10);
      final clock = _Clock(phone);
      final board = RiderBoard(
        serverNow: phone.add(const Duration(days: 3)),
        offers: [_offer(_held, code: 'DL-4821', shop: 'Sharma Sweets', held: true, expires: phone.add(const Duration(seconds: 179)))],
      );
      await _pump(tester, jobs: _FakeJobs(board), clock: clock);
      final countdown = find.byKey(const Key('countdown-$_held'));
      expect(find.descendant(of: countdown, matching: find.text('2:59')), findsOneWidget);
    });

    testWidgets('a phone clock 3 minutes slow does not stretch the window', (tester) async {
      final server = DateTime.utc(2026, 10, 21, 10);
      final clock = _Clock(server.subtract(const Duration(minutes: 3)));
      final board = RiderBoard(
        serverNow: server,
        offers: [_offer(_held, code: 'DL-4821', shop: 'Sharma Sweets', held: true, expires: server.add(const Duration(seconds: 2)))],
      );
      await _pump(tester, jobs: _FakeJobs(board), clock: clock);
      expect(find.text('Held for you'), findsWidgets);
      await _tick(tester, clock, 2);
      expect(find.text('Held for you'), findsNothing);
      expect(find.text('Open to everyone'), findsWidgets);
    });

    testWidgets('shows 2:59, runs down, and at 0:00 the card opens to everyone', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      await _pump(tester, jobs: _FakeJobs(_offers(clock)), clock: clock);

      final countdown = find.byKey(const Key('countdown-$_held'));
      expect(find.descendant(of: countdown, matching: find.text('2:59')), findsOneWidget);
      await _tick(tester, clock, 1);
      expect(find.descendant(of: countdown, matching: find.text('2:58')), findsOneWidget);

      await _tick(tester, clock, 177); // 2:58 - 177 s = 0:01
      expect(find.descendant(of: countdown, matching: find.text('0:01')), findsOneWidget);
      expect(_reject, findsOneWidget);

      await _tick(tester, clock, 1);
      expect(find.byKey(const Key('offer-card-$_held')), findsOneWidget);
      expect(find.text('Open to everyone'), findsWidgets);
      expect(find.text('Held for you'), findsNothing);
      expect(countdown, findsNothing);
      // Anyone may take it now: Accept stays, Reject (the exclusive window's) goes.
      expect(_accept, findsOneWidget);
      expect(_reject, findsNothing);
    });

    testWidgets('a fresh board that no longer lists the offer removes the card', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock, heldSeconds: 3));
      await _pump(tester, jobs: jobs, clock: clock);
      await _tick(tester, clock, 3);
      expect(find.text('Open to everyone'), findsWidgets);

      jobs.current = RiderBoard(offers: [_offers(clock).offers[1]]);
      await _tick(tester, clock, 2); // the 5 s poll
      await _settle(tester);
      expect(find.byKey(const Key('offer-card-$_held')), findsNothing);
      expect(find.byKey(const Key('offer-card-$_open')), findsOneWidget);
    });
  });

  group('accept', () {
    testWidgets('calls accept, then the next board shows the active delivery', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock))
        ..afterAccept = (_) => RiderBoard(active: _active());
      final h = await _pump(tester, jobs: jobs, clock: clock);

      await _tap(tester, _accept);

      expect(jobs.accepted, [_held]);
      expect(find.byKey(const Key('active-delivery')), findsOneWidget);
      expect(find.text('Active delivery'), findsOneWidget);
      expect(find.textContaining('DL-4821'), findsOneWidget);
      expect(find.byKey(const Key('offer-card-$_held')), findsNothing);
      // The ring for this order ends with the answer.
      expect(h.ring.calls, contains('stop rider:$_held'));
    });

    testWidgets('both buttons wait while the answer is on its way', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock))..holdAccept = Completer<void>();
      await _pump(tester, jobs: jobs, clock: clock);

      await tester.tap(_accept);
      await tester.pump();
      expect(tester.widget<FilledButton>(_accept).onPressed, isNull);
      expect(tester.widget<OutlinedButton>(_reject).onPressed, isNull);
      jobs.holdAccept!.complete();
      await _settle(tester);
    });

    testWidgets('reserved: another rider is holding this order', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock))..acceptError = ApiException(409, 'reserved');
      await _pump(tester, jobs: jobs, clock: clock);
      await _tap(tester, _accept);
      expect(find.text('Another rider is holding this order'), findsOneWidget);
      // The board is asked again, so the card shows what is true now.
      expect(jobs.boardCalls, greaterThan(1));
    });

    testWidgets('no connection: says so, keeps the card', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock))..acceptError = ApiException(0, 'network');
      await _pump(tester, jobs: jobs, clock: clock);
      await _tap(tester, _accept);
      expect(find.textContaining('No connection'), findsWidgets);
      expect(find.byKey(const Key('offer-card-$_held')), findsOneWidget);
    });

    testWidgets('documents_expired: says so and opens Profile & documents', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock))..acceptError = ApiException(409, 'documents_expired');
      await _pump(tester, jobs: jobs, clock: clock, routed: true);
      await _tap(tester, _accept);
      expect(
        find.text('Your documents have expired. Upload new ones in Profile & documents to take jobs.'),
        findsOneWidget,
      );
      final action = find.byKey(const Key('jobs-notice-action'));
      expect(action, findsOneWidget);
      await _tap(tester, action);
      expect(find.text('documents page'), findsOneWidget);
    });

    testWidgets('other refusals have no action button', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock))..acceptError = ApiException(409, 'reserved');
      await _pump(tester, jobs: jobs, clock: clock);
      await _tap(tester, _accept);
      expect(find.byKey(const Key('jobs-notice-action')), findsNothing);
      expect(offerErrorOpensProfile(ApiException(409, 'reserved')), isFalse);
      expect(offerErrorOpensProfile(ApiException(409, 'documents_expired')), isTrue);
    });

    test('every offer error has its own plain sentence', () {
      const codes = [
        'documents_expired',
        'reserved',
        'offer_expired',
        'already_taken',
        'not_ready',
        'not_online',
        'rejected',
        'not_offered',
        'invalid_reason',
        'migration_pending',
        'network',
      ];
      final seen = <String>{};
      for (final code in codes) {
        final text = offerError(ApiException(409, code));
        expect(text, isNot(contains('Something went wrong')), reason: code);
        expect(text, isNot(contains(code)), reason: code);
        expect(RegExp('[\\u0900-\\u097F]').hasMatch(text), isFalse);
        expect(seen.add(text), isTrue, reason: '$code repeats another sentence');
      }
      expect(offerError(ApiException(409, 'reserved')), 'Another rider is holding this order');
      expect(offerError(ApiException(500, 'surprise')), contains('Something went wrong'));
    });
  });

  group('reject', () {
    testWidgets('Send stays disabled until a reason is chosen', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock));
      await _pump(tester, jobs: jobs, clock: clock);

      await _tap(tester, _reject);
      final send = find.byKey(const Key('reject-send'));
      expect(send, findsOneWidget);
      expect(tester.widget<FilledButton>(send).onPressed, isNull);
      for (final r in ['Too far', 'Vehicle problem', 'On a break', 'Low battery', 'Other']) {
        expect(find.text(r), findsOneWidget, reason: r);
      }
      await tester.tap(send, warnIfMissed: false);
      await _settle(tester);
      expect(jobs.rejected, isEmpty);
    });

    testWidgets('sends the reason and the card goes', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock));
      final h = await _pump(tester, jobs: jobs, clock: clock);

      await _tap(tester, _reject);
      await _tap(tester, find.byKey(const Key('reason-too_far')));
      expect(tester.widget<FilledButton>(find.byKey(const Key('reject-send'))).onPressed, isNotNull);
      await _tap(tester, find.byKey(const Key('reject-send')));

      expect(jobs.rejected.single.id, _held);
      expect(jobs.rejected.single.reason, 'too_far');
      expect(jobs.rejected.single.note, isNull);
      expect(find.byKey(const Key('offer-card-$_held')), findsNothing);
      expect(h.ring.calls, contains('stop rider:$_held'));
    });

    testWidgets('Other takes a note and sends it', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock));
      await _pump(tester, jobs: jobs, clock: clock);

      await _tap(tester, _reject);
      expect(find.byKey(const Key('reject-note')), findsNothing);
      await _tap(tester, find.byKey(const Key('reason-other')));
      await tester.enterText(find.byKey(const Key('reject-note')), 'Road is flooded');
      await tester.pump();
      await _tap(tester, find.byKey(const Key('reject-send')));

      expect(jobs.rejected.single.reason, 'other');
      expect(jobs.rejected.single.note, 'Road is flooded');
    });

    testWidgets('cancelling the sheet changes nothing', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock));
      await _pump(tester, jobs: jobs, clock: clock);
      await _tap(tester, _reject);
      await tester.tap(find.byKey(const Key('reject-cancel')));
      await _settle(tester);
      expect(jobs.rejected, isEmpty);
      expect(find.byKey(const Key('offer-card-$_held')), findsOneWidget);
    });

    testWidgets('not_offered (it moved on) says so', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock))..rejectError = ApiException(409, 'not_offered');
      await _pump(tester, jobs: jobs, clock: clock);
      await _tap(tester, _reject);
      await _tap(tester, find.byKey(const Key('reason-low_battery')));
      await _tap(tester, find.byKey(const Key('reject-send')));
      expect(find.text(offerError(ApiException(409, 'not_offered'))), findsOneWidget);
    });
  });

  group('states', () {
    testWidgets('an offline rider sees the offline empty state with the switch', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      await _pump(tester, jobs: _FakeJobs(const RiderBoard()), clock: clock, online: false);
      expect(find.text("You're offline — go online to get orders"), findsOneWidget);
      expect(find.byKey(const Key('availability-switch')), findsOneWidget);
    });

    testWidgets('an online rider with nothing offered sees that, not an error', (tester) async {
      await _pump(tester, jobs: _FakeJobs(const RiderBoard()));
      expect(find.text('No orders right now'), findsOneWidget);
      expect(find.byKey(const Key('availability-switch')), findsNothing);
    });

    testWidgets('a board that cannot load, with nothing to show, offers a retry', (tester) async {
      final jobs = _FakeJobs(const RiderBoard())..boardError = ApiException(0, 'network');
      await _pump(tester, jobs: jobs);
      expect(find.text('Try again'), findsOneWidget);
      jobs.boardError = null;
      await _tap(tester, find.text('Try again'));
      expect(find.text('No orders right now'), findsOneWidget);
    });

    testWidgets('a poll that fails keeps the last orders and says it could not refresh', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock));
      await _pump(tester, jobs: jobs, clock: clock);
      jobs.boardError = ApiException(0, 'network');
      await _tick(tester, clock, 5);
      await _settle(tester);
      expect(find.byKey(const Key('offer-card-$_held')), findsOneWidget);
      expect(find.byKey(const Key('jobs-stale')), findsOneWidget);
      jobs.boardError = null;
      await _tick(tester, clock, 5);
      await _settle(tester);
      expect(find.byKey(const Key('jobs-stale')), findsNothing);
    });

    testWidgets('with an active delivery the tab shows it, not the offers', (tester) async {
      final jobs = _FakeJobs(RiderBoard(active: _active(), offers: [
        _offer(_open, code: 'DL-4822', shop: 'Annapurna Kitchen'),
      ]));
      await _pump(tester, jobs: jobs);
      expect(find.byKey(const Key('active-delivery')), findsOneWidget);
      expect(find.byKey(const Key('offer-row-$_open')), findsNothing);
      expect(find.byKey(const Key('offer-card-$_open')), findsNothing);
    });

    testWidgets('no signal mid-delivery: the copy on the phone is shown', (tester) async {
      final jobs = _FakeJobs(const RiderBoard())..boardError = ApiException(0, 'network');
      await _pump(tester, jobs: jobs, prefs: {ActiveDeliveryCache.key: jsonEncode(_active().toJson())});
      expect(find.byKey(const Key('active-delivery')), findsOneWidget);
    });
  });

  group('polling', () {
    testWidgets('asks again every 5 seconds while visible', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock));
      await _pump(tester, jobs: jobs, clock: clock);
      final first = jobs.boardCalls;
      await _tick(tester, clock, 4);
      expect(jobs.boardCalls, first);
      await _tick(tester, clock, 1);
      await _settle(tester);
      expect(jobs.boardCalls, first + 1);
      await _tick(tester, clock, 5);
      await _settle(tester);
      expect(jobs.boardCalls, first + 2);
    });

    testWidgets('asks at once when the app comes back to the front', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock));
      await _pump(tester, jobs: jobs, clock: clock);
      final before = jobs.boardCalls;
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pump();
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await _settle(tester);
      expect(jobs.boardCalls, before + 1);
    });

    testWidgets('does not poll while the tab is hidden', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock));
      tester.view.physicalSize = const Size(360 * 3, 720 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      SharedPreferences.setMockInitialValues({});
      final visible = ValueNotifier<bool>(true);
      final container = ProviderContainer(overrides: [
        prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
        jobsRepoProvider.overrideWithValue(jobs),
        clockProvider.overrideWithValue(clock.call),
        ringChannelProvider.overrideWithValue(_FakeRing()),
        meProvider.overrideWith((_) async => _me()),
      ]);
      addTearDown(container.dispose);
      await tester.pumpWidget(UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          theme: buildTheme(Brightness.light),
          home: ValueListenableBuilder<bool>(
            valueListenable: visible,
            // What the tab bar's branch container does to a tab that is not showing.
            builder: (_, on, child) => TickerMode(enabled: on, child: child!),
            child: const JobsScreen(),
          ),
        ),
      ));
      await _settle(tester);
      visible.value = false;
      await tester.pump();
      final hiddenAt = jobs.boardCalls;
      await _tick(tester, clock, 20);
      expect(jobs.boardCalls, hiddenAt);
      visible.value = true;
      await _settle(tester);
      expect(jobs.boardCalls, hiddenAt + 1, reason: 'asks as soon as it shows again');
    });
    testWidgets('inside the tab bar: polls on the Jobs tab, stops on another tab, asks again on return', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final jobs = _FakeJobs(_offers(clock));
      tester.view.physicalSize = const Size(360 * 3, 720 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      SharedPreferences.setMockInitialValues({});
      final container = ProviderContainer(overrides: [
        prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
        jobsRepoProvider.overrideWithValue(jobs),
        clockProvider.overrideWithValue(clock.call),
        ringChannelProvider.overrideWithValue(_FakeRing()),
        meProvider.overrideWith((_) async => _me()),
      ]);
      addTearDown(container.dispose);
      final router = GoRouter(
        initialLocation: '/home',
        routes: [
          StatefulShellRoute.indexedStack(
            builder: (_, _, shell) => Scaffold(
              body: shell,
              bottomNavigationBar: NavigationBar(
                selectedIndex: shell.currentIndex,
                onDestinationSelected: shell.goBranch,
                destinations: const [
                  NavigationDestination(icon: Icon(Icons.home), label: 'Home'),
                  NavigationDestination(icon: Icon(Icons.work), label: 'Jobs'),
                ],
              ),
            ),
            branches: [
              StatefulShellBranch(routes: [GoRoute(path: '/home', builder: (_, _) => const Text('home page'))]),
              StatefulShellBranch(routes: [jobsRoute]),
            ],
          ),
        ],
      );
      addTearDown(router.dispose);
      await tester.pumpWidget(UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(theme: buildTheme(Brightness.light), routerConfig: router),
      ));
      await _settle(tester);
      expect(jobs.boardCalls, 0, reason: 'never visited, never asked');

      await _tap(tester, find.text('Jobs'));
      final onJobs = jobs.boardCalls;
      expect(onJobs, greaterThan(0));
      await _tick(tester, clock, 5);
      await _settle(tester);
      expect(jobs.boardCalls, onJobs + 1);

      await _tap(tester, find.text('Home'));
      final left = jobs.boardCalls;
      await _tick(tester, clock, 20);
      expect(jobs.boardCalls, left, reason: 'no polling out of sight');

      await _tap(tester, find.text('Jobs'));
      expect(jobs.boardCalls, left + 1, reason: 'asks as soon as the tab shows again');
    });
  });

  group('ringing', () {
    testWidgets('an offline rider is not rung for', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final h = await _pump(tester, jobs: _FakeJobs(_offers(clock)), clock: clock, online: false);
      await _tick(tester, clock, 5);
      await _settle(tester);
      expect(h.ring.calls.where((c) => c.startsWith('start')), isEmpty);
    });

    testWidgets('the open board rings for the offer held for this rider, once', (tester) async {
      final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
      final h = await _pump(tester, jobs: _FakeJobs(_offers(clock)), clock: clock);
      await _tick(tester, clock, 5);
      await _settle(tester);
      expect(h.ring.calls.where((c) => c == 'start rider:$_held'), hasLength(1));
      expect(h.ring.calls.where((c) => c.contains(_open)), isEmpty);
    });
  });

  group('fixture backend', () {
    testWidgets('accepting a fixture offer makes it the active delivery', (tester) async {
      final now = DateTime.utc(2026, 10, 21, 10);
      final clock = _Clock(now);
      final repo = FixtureJobsRepository.create(scenario: 'offers', now: now);
      await _pump(tester, jobs: _FakeJobs(const RiderBoard()), clock: clock, repo: repo);
      expect(find.text('Held for you'), findsOneWidget);
      expect(find.text('2:30'), findsOneWidget);
      await _tap(tester, _accept);
      expect(find.byKey(const Key('active-delivery')), findsOneWidget);
    });
  });

  group('looks', () {
    for (final (name, brightness, scale) in [
      ('light', Brightness.light, 1.0),
      ('dark', Brightness.dark, 1.0),
      ('light at 1.3x text', Brightness.light, 1.3),
      ('dark at 1.3x text', Brightness.dark, 1.3),
    ]) {
      testWidgets('offers render without overflow: $name', (tester) async {
        final clock = _Clock(DateTime.utc(2026, 10, 21, 10));
        await _pump(
          tester,
          jobs: _FakeJobs(_offers(clock, earning: 60)),
          clock: clock,
          brightness: brightness,
          textScale: scale,
        );
        expect(tester.takeException(), isNull);
        await tester.scrollUntilVisible(_reject, 200);
        await _tap(tester, _reject);
        expect(find.byKey(const Key('reject-send')), findsOneWidget);
        expect(tester.takeException(), isNull);
        await _tap(tester, find.byKey(const Key('reason-other')));
        expect(tester.takeException(), isNull);
        await _tap(tester, find.byKey(const Key('reject-cancel')));
        await tester.scrollUntilVisible(find.textContaining('Bake House'), 300);
        expect(tester.takeException(), isNull);
      });

      testWidgets('offline state renders without overflow: $name', (tester) async {
        await _pump(
          tester,
          jobs: _FakeJobs(const RiderBoard()),
          online: false,
          brightness: brightness,
          textScale: scale,
        );
        expect(tester.takeException(), isNull);
      });
    }
  });
}

