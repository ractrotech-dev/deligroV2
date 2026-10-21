import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../core/format.dart';
import '../models/outcome.dart';
import '../models/products.dart';
import '../widgets/zone_picker.dart';
import 'paged.dart';
import 'providers.dart';

typedef ProductList = Paged<ProductListItem, ProductCounts>;

/// The Products list for one set of filters (zone folded in by the screen).
class ProductListNotifier extends AsyncNotifier<ProductList> {
  ProductListNotifier(this.filters);
  final ProductFilters filters;

  static String _id(ProductListItem p) => p.id;

  @override
  Future<ProductList> build() async {
    ref.watch(signedInProvider);
    final p = await ref.read(productsRepoProvider).list(filters);
    return Paged.first(p.items, p.nextCursor, p.counts ?? const ProductCounts());
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final p = await ref.read(productsRepoProvider).list(filters, cursor: s.nextCursor);
      state = AsyncData((state.value ?? s).append(p.items, p.nextCursor, _id));
    } catch (_) {
      state = AsyncData((state.value ?? s).copyWith(loadingMore: false, loadMoreFailed: true));
    }
  }

  Future<void> refresh() async {
    final s = state.value;
    if (s == null) {
      ref.invalidateSelf();
      return;
    }
    try {
      final p = await ref.read(productsRepoProvider).list(filters);
      state = AsyncData((state.value ?? s).refreshedWith(p.items, p.nextCursor, p.counts ?? s.counts, _id));
    } catch (_) {
      // Keep what is on screen.
    }
  }
}

final productListProvider = AsyncNotifierProvider.autoDispose.family<ProductListNotifier, ProductList, ProductFilters>(
  ProductListNotifier.new,
  retry: (_, _) => null,
);

/// One listing. `act` adopts the listing the server returns, and re-reads it
/// after a refusal (it changed under us).
class ProductDetailNotifier extends AsyncNotifier<ProductDetail> {
  ProductDetailNotifier(this.productId);
  final String productId;

  @override
  Future<ProductDetail> build() async {
    ref.watch(signedInProvider);
    return ref.read(productsRepoProvider).detail(productId);
  }

  Future<void> refresh() async {
    if (!state.hasValue) {
      ref.invalidateSelf();
      return;
    }
    final next = await AsyncValue.guard(() => ref.read(productsRepoProvider).detail(productId));
    if (next.hasValue) state = next;
  }

  /// Throws on a network or server fault (retry with the same action).
  Future<Outcome<ProductDetail>> act(ProductAction a) async {
    final out = await ref.read(productsRepoProvider).act(productId, a);
    switch (out) {
      case Applied(:final value?):
        state = AsyncData(value);
      case Applied() || Refused():
        await refresh();
    }
    return out;
  }
}

final productDetailProvider = AsyncNotifierProvider.autoDispose.family<ProductDetailNotifier, ProductDetail, String>(
  ProductDetailNotifier.new,
  retry: (_, _) => null,
);

/// Categories across the manager's vendors, in the picked zone.
final productCategoriesProvider = FutureProvider.autoDispose<List<CategoryRow>>(
  (ref) => ref.read(productsRepoProvider).categories(zoneId: ref.watch(activeZoneProvider)?.id),
  retry: (_, _) => null,
);

/// The insights window: the last N IST days, or a custom range.
class InsightsRange {
  const InsightsRange.days(this.days)
      : from = null,
        to = null;
  const InsightsRange.custom(DateTime this.from, DateTime this.to) : days = null;

  final int? days;
  final DateTime? from;
  final DateTime? to;

  static final _fmt = DateFormat('yyyy-MM-dd');

  /// Inclusive `YYYY-MM-DD` dates (IST), ending today for a preset.
  (String, String) bounds([DateTime? now]) {
    if (days == null) return (_fmt.format(from!), _fmt.format(to!));
    final today = istToday(now);
    return (_fmt.format(today.subtract(Duration(days: days! - 1))), _fmt.format(today));
  }

  @override
  bool operator ==(Object other) => other is InsightsRange && other.days == days && other.from == from && other.to == to;

  @override
  int get hashCode => Object.hash(days, from, to);
}

/// The server takes at most 92 days, ending no later than today in India.
const insightsMaxDays = 92;

/// Why a custom insights range can't be asked for, or null.
String? insightsRangeProblem(DateTime from, DateTime to, {DateTime? now}) {
  final f = DateTime(from.year, from.month, from.day), t = DateTime(to.year, to.month, to.day);
  if (t.isAfter(istToday(now))) return "The range can't end after today.";
  if (t.difference(f).inDays + 1 > insightsMaxDays) return 'Pick $insightsMaxDays days or fewer.';
  return null;
}

class InsightsRangeNotifier extends Notifier<InsightsRange> {
  @override
  InsightsRange build() => const InsightsRange.days(30);
  void set(InsightsRange r) => state = r;
}

final insightsRangeProvider = NotifierProvider<InsightsRangeNotifier, InsightsRange>(InsightsRangeNotifier.new);

final productInsightsProvider = FutureProvider.autoDispose<ProductInsights>(
  (ref) {
    final (from, to) = ref.watch(insightsRangeProvider).bounds();
    return ref.read(productsRepoProvider).insights(from: from, to: to, zoneId: ref.watch(activeZoneProvider)?.id);
  },
  retry: (_, _) => null,
);

final restrictedCategoriesProvider = FutureProvider.autoDispose<List<RestrictedCategory>>(
  (ref) => ref.read(productsRepoProvider).restricted(),
  retry: (_, _) => null,
);

/// The first page of vendor photos waiting for a look (§12.7); the screen pages on.
final imageReviewsProvider = FutureProvider.autoDispose<ImageReviewPage>((ref) {
  ref.watch(signedInProvider);
  return ref.read(productsRepoProvider).imageReviews();
});
