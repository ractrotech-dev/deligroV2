import 'dart:async';

import 'package:deligro_manager/data/manager_repository.dart';
import 'package:deligro_manager/models/dashboard.dart';
import 'package:deligro_manager/models/manager_me.dart';
import 'package:deligro_manager/state/dashboard.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:deligro_manager/widgets/zone_picker.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class _MockRepo extends Mock implements ManagerRepository {}

class _ZoneN extends Notifier<Zone?> {
  @override
  Zone? build() => null;
  void set(Zone? z) => state = z;
}

final _zone = NotifierProvider<_ZoneN, Zone?>(_ZoneN.new);

DashboardData _data(int totalSales) => DashboardData.fromJson({
      'today': '2026-10-21',
      'generatedAt': '2026-10-21T09:30:00.000Z',
      'zone': null,
      'order': ['totalSales'],
      'figures': {'totalSales': totalSales},
      'unavailable': <String>[],
    });

const _a = Zone(id: 'zone-a', name: 'A', slug: 'a', cityName: 'Bemetara');
const _b = Zone(id: 'zone-b', name: 'B', slug: 'b', cityName: 'Bemetara');

ProviderContainer _container(_MockRepo repo) => ProviderContainer(overrides: [
      managerRepoProvider.overrideWithValue(repo),
      signedInProvider.overrideWithValue(true),
      activeZoneProvider.overrideWith((ref) => ref.watch(_zone)),
    ]);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test("a late answer for the previous zone never overwrites the new zone's figures", () async {
    final repo = _MockRepo();
    final slowA = Completer<DashboardData>();
    var aCalls = 0;
    when(() => repo.dashboard(zoneId: 'zone-a')).thenAnswer((_) {
      aCalls++;
      return aCalls == 1 ? Future.value(_data(1)) : slowA.future;
    });
    when(() => repo.dashboard(zoneId: 'zone-b')).thenAnswer((_) async => _data(2));
    final c = _container(repo);
    addTearDown(c.dispose);
    final sub = c.listen(dashboardProvider, (_, _) {});
    addTearDown(sub.close);

    c.read(_zone.notifier).set(_a);
    expect((await c.read(dashboardProvider.future)).figures.values.single, 1);

    // A refresh for zone A starts, then the manager switches to zone B.
    final pending = c.read(dashboardProvider.notifier).refresh();
    c.read(_zone.notifier).set(_b);
    expect((await c.read(dashboardProvider.future)).figures.values.single, 2);

    // Zone A's answer arrives late.
    slowA.complete(_data(99));
    await pending;
    expect(c.read(dashboardProvider).value!.figures.values.single, 2);
  });

  test('the 30-second refresh pauses while Home is not on screen', () {
    fakeAsync((async) {
      final repo = _MockRepo();
      var calls = 0;
      when(() => repo.dashboard(zoneId: any(named: 'zoneId'))).thenAnswer((_) async {
        calls++;
        return _data(calls);
      });
      final c = _container(repo);
      final sub = c.listen(dashboardProvider, (_, _) {});
      async.flushMicrotasks();
      expect(calls, 1);

      async.elapse(dashboardRefresh);
      expect(calls, 2, reason: 'refreshes while visible');

      c.read(dashboardProvider.notifier).setVisible(false);
      async.elapse(dashboardRefresh * 4);
      expect(calls, 2, reason: 'no refresh while another tab or screen is in front');

      c.read(dashboardProvider.notifier).setVisible(true);
      async.flushMicrotasks();
      expect(calls, 3, reason: 'coming back after a while refreshes at once');
      async.elapse(dashboardRefresh);
      expect(calls, 4, reason: 'and the timer runs again');

      sub.close();
      c.dispose();
    });
  });
}
