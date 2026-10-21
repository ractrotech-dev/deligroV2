import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/outcome.dart';
import '../models/vendors.dart';
import 'paged.dart';
import 'providers.dart';

typedef VendorList = Paged<VendorListItem, VendorCounts>;

/// The Vendors list for one set of filters (zone folded in by the screen).
/// Keyset-paged, refreshed in place on pull-to-refresh.
class VendorListNotifier extends AsyncNotifier<VendorList> {
  VendorListNotifier(this.filters);
  final VendorFilters filters;

  static String _id(VendorListItem v) => v.id;

  @override
  Future<VendorList> build() async {
    ref.watch(signedInProvider);
    final p = await ref.read(vendorsRepoProvider).list(filters);
    return Paged.first(p.items, p.nextCursor, p.counts);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final p = await ref.read(vendorsRepoProvider).list(filters, cursor: s.nextCursor);
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
      final p = await ref.read(vendorsRepoProvider).list(filters);
      state = AsyncData((state.value ?? s).refreshedWith(p.items, p.nextCursor, p.counts, _id));
    } catch (_) {
      // A failed background refresh keeps what is on screen.
    }
  }
}

final vendorListProvider = AsyncNotifierProvider.autoDispose.family<VendorListNotifier, VendorList, VendorFilters>(
  VendorListNotifier.new,
  retry: (_, _) => null,
);

/// One vendor. `act` sends an audited decision and adopts the vendor the
/// server returns; on a refusal (someone else moved it) it re-reads.
class VendorDetailNotifier extends AsyncNotifier<VendorDetail> {
  VendorDetailNotifier(this.vendorId);
  final String vendorId;

  @override
  Future<VendorDetail> build() async {
    ref.watch(signedInProvider);
    return ref.read(vendorsRepoProvider).detail(vendorId);
  }

  Future<void> refresh() async {
    if (!state.hasValue) {
      ref.invalidateSelf();
      return;
    }
    final next = await AsyncValue.guard(() => ref.read(vendorsRepoProvider).detail(vendorId));
    if (next.hasValue) state = next;
  }

  /// Throws on a network or server fault so the caller can retry with the
  /// same action (same `clientActionId`).
  Future<Outcome<VendorDetail>> act(VendorAction a) async {
    final out = await ref.read(vendorsRepoProvider).act(vendorId, a);
    switch (out) {
      case Applied(:final value?):
        state = AsyncData(value);
      case Applied():
        await refresh();
      case Refused():
        await refresh();
    }
    return out;
  }
}

final vendorDetailProvider = AsyncNotifierProvider.autoDispose.family<VendorDetailNotifier, VendorDetail, String>(
  VendorDetailNotifier.new,
  retry: (_, _) => null,
);
