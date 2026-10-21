import 'package:deligro_partner/state/orders.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'support/fakes.dart';

void main() {
  const ArchiveQuery query = (kind: 'completed', range: 'all', date: null, search: '');
  String id(int i) => 'ee55ee55-0000-0000-0000-${i.toString().padLeft(12, '0')}';

  late MockOrdersRepo repo;
  late ProviderContainer container;

  void stubPage(int offset, List<int> ids, int total) => when(
    () => repo.history(
      kind: any(named: 'kind'),
      range: any(named: 'range'),
      date: any(named: 'date'),
      search: any(named: 'search'),
      limit: any(named: 'limit'),
      offset: offset,
    ),
  ).thenAnswer((_) async => (orders: [for (final i in ids) fakeOrder(id(i), status: 'delivered')], total: total));

  setUp(() {
    repo = MockOrdersRepo();
    container = ProviderContainer(overrides: [ordersRepoProvider.overrideWithValue(repo)]);
  });
  tearDown(() => container.dispose());

  test('pages through past orders and stops at the total', () async {
    stubPage(0, [1, 2], 3);
    stubPage(2, [3], 3);
    final sub = container.listen(archiveProvider(query), (_, _) {});

    var page = await container.read(archiveProvider(query).future);
    expect(page.orders.length, 2);
    expect(page.total, 3);

    await container.read(archiveProvider(query).notifier).loadMore();
    page = container.read(archiveProvider(query)).value!;
    expect(page.orders.map((o) => o.id), [id(1), id(2), id(3)]);

    // Everything is loaded: no further request.
    await container.read(archiveProvider(query).notifier).loadMore();
    verify(
      () => repo.history(
        kind: 'completed',
        range: 'all',
        date: null,
        search: '',
        limit: ArchiveNotifier.pageSize,
        offset: any(named: 'offset'),
      ),
    ).called(2);
    sub.close();
  });

  test('an empty page ends paging instead of offering more forever', () async {
    stubPage(0, [1], 5);
    stubPage(1, [], 5);
    final sub = container.listen(archiveProvider(query), (_, _) {});

    await container.read(archiveProvider(query).future);
    await container.read(archiveProvider(query).notifier).loadMore();
    final page = container.read(archiveProvider(query)).value!;
    expect(page.orders.length, 1);
    expect(page.total, 1);
    sub.close();
  });
}
