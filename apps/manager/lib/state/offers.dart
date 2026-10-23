import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/offers_repository.dart';
import '../models/offers.dart';
import '../models/outcome.dart';
import 'paged.dart';
import 'paged_list.dart';
import 'providers.dart';

/// Offers (§9). Overridden with a fake in tests.
final offersRepoProvider = Provider<OffersRepository>((ref) => ApiOffersRepository(ref.watch(apiProvider)));

typedef OfferList = Paged<OfferSummary, OfferCounts>;

class OfferListNotifier extends PagedListNotifier<OfferSummary, OfferCounts> {
  OfferListNotifier(this.filters);
  final OfferFilters filters;

  @override
  Future<PageOf<OfferSummary, OfferCounts>> fetch({String? cursor}) async {
    final p = await ref.read(offersRepoProvider).list(filters, cursor: cursor);
    return (items: p.items, next: p.nextCursor, counts: p.counts);
  }

  @override
  String idOf(OfferSummary row) => row.code;
}

final offerListProvider = AsyncNotifierProvider.autoDispose.family<OfferListNotifier, OfferList, OfferFilters>(
  OfferListNotifier.new,
  retry: (_, _) => null,
);

typedef OfferKey = ({String code, String? from, String? to});

/// One offer with its usage over a range and its change history.
class OfferDetailNotifier extends AsyncNotifier<OfferBundle> {
  OfferDetailNotifier(this.key);
  final OfferKey key;

  @override
  Future<OfferBundle> build() async {
    ref.watch(signedInProvider);
    return ref.read(offersRepoProvider).detail(key.code, from: key.from, to: key.to);
  }

  Future<void> refresh() async {
    if (!state.hasValue) {
      ref.invalidateSelf();
      return;
    }
    final next = await AsyncValue.guard(() => ref.read(offersRepoProvider).detail(key.code, from: key.from, to: key.to));
    if (next.hasValue) state = next;
  }

  /// Activate / deactivate; re-reads afterwards so usage and history move too.
  Future<Outcome<OfferDetail>> act(OfferAction a) async {
    final out = await ref.read(offersRepoProvider).act(key.code, a);
    await refresh();
    return out;
  }
}

final offerDetailProvider = AsyncNotifierProvider.autoDispose.family<OfferDetailNotifier, OfferBundle, OfferKey>(
  OfferDetailNotifier.new,
  retry: (_, _) => null,
);
