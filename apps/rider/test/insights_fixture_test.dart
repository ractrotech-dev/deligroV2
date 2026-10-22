// The fixture insights backend: never in a release build, and shaped like the
// server so the preview screens show real layouts.
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/data/fixtures/fixture_insights.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final now = DateTime.utc(2026, 10, 22, 3, 30);

  test('refuses to exist in a release build', () {
    expect(
      () => FixtureInsightsRepository.create(releaseMode: true),
      throwsStateError,
    );
  });

  test('a busy rider has twelve figures worth of data and 45 jobs in pages of 20', () async {
    final repo = FixtureInsightsRepository.create(now: now, scenario: 'busy');
    final d = await repo.dashboard();
    expect(d.today.deliveries, 9);
    expect(d.money, isNotNull);
    expect(d.current, isNotNull);
    final p1 = await repo.history();
    expect(p1.items, hasLength(20));
    final p2 = await repo.history(cursor: p1.nextCursor);
    final p3 = await repo.history(cursor: p2.nextCursor);
    expect(p3.items, hasLength(5));
    expect(p3.nextCursor, isNull);
    final ids = [...p1.items, ...p2.items, ...p3.items].map((i) => i.orderId);
    expect(ids.toSet(), hasLength(45));
    final detail = await repo.historyDetail(p1.items.first.orderId);
    expect(detail.timeline, isNotEmpty);
    expect((await repo.performance()).months, hasLength(12));
    await expectLater(
      repo.historyDetail('nope'),
      throwsA(isA<ApiException>()),
    );
  });

  test('an empty rider has nothing and no money to hide', () async {
    final repo = FixtureInsightsRepository.create(now: now, scenario: 'empty');
    expect((await repo.history()).items, isEmpty);
    expect((await repo.performance()).acceptanceRate, isNull);
    expect((await repo.dashboard()).current, isNull);
  });

  test('earnings off carries no money anywhere', () async {
    final repo = FixtureInsightsRepository.create(now: now, scenario: 'off');
    expect((await repo.dashboard()).money, isNull);
    expect((await repo.history()).items.every((i) => i.earning == null), isTrue);
    expect((await repo.performance()).months.every((m) => m.earnings == null), isTrue);
  });
}
