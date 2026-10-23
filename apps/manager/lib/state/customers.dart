import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/customers_repository.dart';
import '../models/customers.dart';
import '../models/finance.dart' show RefundPage;
import '../models/outcome.dart';
import '../models/tickets.dart';
import 'paged.dart';
import 'paged_list.dart';
import 'providers.dart';

/// Customers (§10). Overridden with a fake in tests.
final customersRepoProvider = Provider<CustomersRepository>((ref) => ApiCustomersRepository(ref.watch(apiProvider)));

typedef CustomerList = Paged<CustomerSummary, void>;

class CustomerListNotifier extends PagedListNotifier<CustomerSummary, void> {
  CustomerListNotifier(this.filters);
  final CustomerFilters filters;

  @override
  Future<PageOf<CustomerSummary, void>> fetch({String? cursor}) async {
    final p = await ref.read(customersRepoProvider).list(filters, cursor: cursor);
    return (items: p.items, next: p.nextCursor, counts: null);
  }

  @override
  String idOf(CustomerSummary row) => row.id;
}

final customerListProvider = AsyncNotifierProvider.autoDispose.family<CustomerListNotifier, CustomerList, CustomerFilters>(
  CustomerListNotifier.new,
  retry: (_, _) => null,
);

/// One customer. [act] adopts the customer the server sends back.
class CustomerDetailNotifier extends AsyncNotifier<CustomerDetail> {
  CustomerDetailNotifier(this.id);
  final String id;

  @override
  Future<CustomerDetail> build() async {
    ref.watch(signedInProvider);
    return ref.read(customersRepoProvider).detail(id);
  }

  Future<void> refresh() async {
    if (!state.hasValue) {
      ref.invalidateSelf();
      return;
    }
    final next = await AsyncValue.guard(() => ref.read(customersRepoProvider).detail(id));
    if (next.hasValue) state = next;
  }

  /// Throws on a fault (including 502 `effect_failed`) so Retry resends the
  /// same action with the same id.
  Future<Outcome<CustomerDetail>> act(CustomerAction a) async {
    final out = await ref.read(customersRepoProvider).act(id, a);
    switch (out) {
      case Applied(:final value?):
        state = AsyncData(value);
      case _:
        await refresh();
    }
    return out;
  }
}

final customerDetailProvider = AsyncNotifierProvider.autoDispose.family<CustomerDetailNotifier, CustomerDetail, String>(
  CustomerDetailNotifier.new,
  retry: (_, _) => null,
);

final customerComplaintsProvider = FutureProvider.autoDispose.family<TicketPage, String>((ref, id) {
  ref.watch(signedInProvider);
  return ref.read(customersRepoProvider).complaints(id);
}, retry: (_, _) => null);

final customerRefundsProvider = FutureProvider.autoDispose.family<RefundPage, String>((ref, id) {
  ref.watch(signedInProvider);
  return ref.read(customersRepoProvider).refunds(id);
}, retry: (_, _) => null);

final customerFeedbackProvider = FutureProvider.autoDispose.family<CustomerFeedback, String>((ref, id) {
  ref.watch(signedInProvider);
  return ref.read(customersRepoProvider).feedback(id);
}, retry: (_, _) => null);

typedef RetentionKey = ({String? from, String? to, String? zoneId});

final retentionProvider = FutureProvider.autoDispose.family<Retention, RetentionKey>((ref, k) {
  ref.watch(signedInProvider);
  return ref.read(customersRepoProvider).retention(from: k.from, to: k.to, zoneId: k.zoneId);
}, retry: (_, _) => null);
