// The in-memory side of a shared phone (final reviews B and C): rider A's
// cash, inbox, board and finished delivery must never carry over to rider B,
// while B's answers load, after they fail, or once B's board is in. And the
// Jobs tab asks the board as soon as it first shows.
import 'dart:async';
import 'dart:io';

import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/data/cash_repository.dart';
import 'package:deligro_rider/data/fixtures/fixture_data.dart';
import 'package:deligro_rider/data/jobs_repository.dart';
import 'package:deligro_rider/data/notifications_repository.dart';
import 'package:deligro_rider/features/jobs/jobs_screen.dart';
import 'package:deligro_rider/models/cash.dart';
import 'package:deligro_rider/models/inbox.dart';
import 'package:deligro_rider/models/jobs.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/cash.dart';
import 'package:deligro_rider/state/delivery.dart';
import 'package:deligro_rider/state/jobs.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/state/support.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _Uid extends Notifier<String?> {
  @override
  String? build() => 'rider-A';
  void set(String? v) => state = v;
}

final _uid = NotifierProvider<_Uid, String?>(_Uid.new);

CashSummary _summary(int pending) => CashSummary(
      toCollect: 0,
      collectedToday: 0,
      depositedToday: 0,
      collectedTotal: pending,
      depositedTotal: 0,
      pending: pending,
      submittedAwaiting: 0,
      oldestUndepositedAt: null,
      overLimit: false,
      overHours: false,
      limit: 0,
      maxHours: 0,
      days: const [],
    );

/// A's answers come at once; every later ask waits for the test.
class _Cash implements CashRepository {
  Completer<CashSummary>? next;
  bool first = true;
  @override
  Future<CashSummary> summary() {
    if (first) {
      first = false;
      return Future.value(_summary(2400));
    }
    next = Completer<CashSummary>();
    return next!.future;
  }

  @override
  dynamic noSuchMethod(Invocation i) => throw UnimplementedError();
}

class _Inbox implements NotificationsRepository {
  Completer<InboxPage>? next;
  bool first = true;
  @override
  Future<InboxPage> inbox({String? before, int limit = 30}) {
    if (first) {
      first = false;
      return Future.value(const InboxPage(
        items: [InboxItem(id: 'a1', category: 'payouts', title: 'Payout recorded', body: 'A: Rs 9000', read: false)],
        unread: 7,
        hasMore: false,
      ));
    }
    next = Completer<InboxPage>();
    return next!.future;
  }

  @override
  dynamic noSuchMethod(Invocation i) => throw UnimplementedError();
}

class _StubBoard extends BoardNotifier {
  @override
  BoardState build() => const BoardState();
  @override
  Future<void> refresh({bool afterAction = false}) async {}
}

class _Jobs implements JobsRepository {
  Map<String, dynamic> next = FixtureData.board('picked_up');
  bool fail = false;
  int calls = 0;
  Completer<void>? hold;

  @override
  Future<RiderBoard> board() async {
    calls++;
    final h = hold;
    if (h != null) await h.future;
    if (fail) throw const SocketException('no signal');
    return RiderBoard.fromJson(next);
  }

  @override
  dynamic noSuchMethod(Invocation i) => throw UnimplementedError('${i.memberName}');
}

Future<void> _tick() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  test("cash and the inbox: B never sees A's, loading or failed", () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final cash = _Cash();
    final inbox = _Inbox();
    final c = ProviderContainer(overrides: [
      prefsProvider.overrideWithValue(prefs),
      userIdProvider.overrideWith((ref) => ref.watch(_uid)),
      cashRepoProvider.overrideWithValue(cash),
      notificationsRepoProvider.overrideWithValue(inbox),
      boardProvider.overrideWith(_StubBoard.new),
      jobsRepoProvider.overrideWithValue(_Jobs()),
    ]);
    addTearDown(c.dispose);
    AsyncValue<CashSummary> cashNow() => c.read(cashSummaryProvider(c.read(riderKeyProvider)));
    AsyncValue<InboxState> inboxNow() => c.read(inboxProvider(c.read(riderKeyProvider)));
    // What the screens do: watch the signed-in rider's.
    final keep = <ProviderSubscription<Object?>>[];
    void watchMine() {
      final key = c.read(riderKeyProvider);
      keep
        ..add(c.listen(cashSummaryProvider(key), (_, _) {}))
        ..add(c.listen(inboxProvider(key), (_, _) {}));
    }

    watchMine();
    c.listen(unreadCountProvider, (_, _) {});
    await c.read(cashSummaryProvider('rider-A').future);
    await c.read(inboxProvider('rider-A').future);
    expect(cashNow().value?.pending, 2400);
    expect(c.read(unreadCountProvider), 7);

    c.read(_uid.notifier).set('rider-B');
    watchMine();
    await _tick();
    // B's answers are on their way.
    expect(cashNow().value, isNull);
    expect(cashNow().isLoading, isTrue);
    expect(inboxNow().value, isNull);
    expect(c.read(unreadCountProvider), 0);

    // ...and fail.
    cash.next!.completeError(ApiException(503, 'server_error'));
    inbox.next!.completeError(ApiException(503, 'server_error'));
    await _tick();
    expect(cashNow().hasError, isTrue);
    expect(cashNow().value, isNull);
    expect(inboxNow().value, isNull);
    expect(c.read(unreadCountProvider), 0);
    for (final s in keep) {
      s.close();
    }
  });

  group('the board and the finished delivery', () {
    late _Jobs jobs;
    late ProviderContainer c;

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      jobs = _Jobs();
      c = ProviderContainer(overrides: [
        prefsProvider.overrideWithValue(prefs),
        userIdProvider.overrideWith((ref) => ref.watch(_uid)),
        jobsRepoProvider.overrideWithValue(jobs),
        meProvider.overrideWith((ref) async => throw ApiException(0, 'network')),
      ]);
      c.listen(boardProvider, (_, _) {});
      c.listen(finishedDeliveryProvider, (_, _) {});
      await _tick();
      await c.read(boardProvider.notifier).refresh();
      expect(c.read(boardProvider).board?.active?.orderId, isNotNull, reason: "A's delivery");
    });

    tearDown(() => c.dispose());

    test('B starts from an empty board, asked for at once', () async {
      final before = jobs.calls;
      jobs.hold = Completer<void>();
      c.read(_uid.notifier).set(null);
      c.read(_uid.notifier).set('rider-B');
      await _tick();
      expect(c.read(boardProvider).board, isNull);
      expect(jobs.calls, greaterThan(before), reason: 'the board is asked again for B');
      jobs.hold!.complete();
    });

    test("B's board failing does not bring A's delivery back", () async {
      jobs.fail = true;
      c.read(_uid.notifier).set('rider-B');
      await _tick();
      await c.read(boardProvider.notifier).refresh();
      expect(c.read(boardProvider).board?.active, isNull);
      expect(c.read(finishedDeliveryProvider), isNull);
    });

    test("B's empty board does not turn A's delivery into a finished card", () async {
      jobs.next = FixtureData.board('idle');
      c.read(_uid.notifier).set('rider-B');
      await _tick();
      await c.read(boardProvider.notifier).refresh();
      await _tick();
      expect(c.read(finishedDeliveryProvider), isNull);
    });

    test("an answer for A that lands after B signed in is dropped", () async {
      jobs.hold = Completer<void>();
      final late = c.read(boardProvider.notifier).refresh(afterAction: true);
      await _tick();
      c.read(_uid.notifier).set('rider-B');
      await _tick();
      jobs.hold!.complete(); // A's answer (and B's first) arrive now
      jobs.hold = null;
      jobs.next = FixtureData.board('idle');
      await late;
      await _tick();
      await c.read(boardProvider.notifier).refresh();
      expect(c.read(boardProvider).board?.active, isNull);
      expect(c.read(finishedDeliveryProvider), isNull);
    });
  });

  testWidgets('the Jobs tab asks the board the moment it first shows', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final jobs = _Jobs()..next = FixtureData.board('idle');
    final c = ProviderContainer(overrides: [
      prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
      jobsRepoProvider.overrideWithValue(jobs),
      meProvider.overrideWith(
        (ref) async => const RiderMe(id: 'rider-1', availability: RiderAvailabilityDto(isOnline: true), phase: 'online'),
      ),
    ]);
    addTearDown(c.dispose);
    // Another screen built the board earlier (the cash strip on Home does).
    final sub = c.listen(boardProvider, (_, _) {});
    await tester.runAsync(() => c.read(boardProvider.notifier).refresh());
    final before = jobs.calls;

    await tester.pumpWidget(UncontrolledProviderScope(
      container: c,
      child: MaterialApp(theme: buildTheme(Brightness.light), home: const JobsScreen()),
    ));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump(const Duration(milliseconds: 100)); // far from the 5 s tick
    expect(jobs.calls, before + 1);
    sub.close();
    await tester.pumpWidget(const SizedBox());
  });
}
