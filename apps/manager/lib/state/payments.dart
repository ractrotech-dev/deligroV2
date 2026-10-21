import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/outcome.dart';
import '../models/payment_request.dart';
import 'paged.dart';
import 'providers.dart';

typedef PaymentList = Paged<PaymentRequest, PaymentCounts>;

/// One Approvals tab. `decide` sends a decision and re-reads the list so the
/// card moves to its new tab.
class PaymentListNotifier extends AsyncNotifier<PaymentList> {
  PaymentListNotifier(this.filters);
  final PaymentRequestFilters filters;

  static String _id(PaymentRequest r) => r.id;

  @override
  Future<PaymentList> build() async {
    ref.watch(signedInProvider);
    final p = await ref.read(paymentsRepoProvider).list(filters);
    return Paged.first(p.items, p.nextCursor, p.counts);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final p = await ref.read(paymentsRepoProvider).list(filters, cursor: s.nextCursor);
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
      final p = await ref.read(paymentsRepoProvider).list(filters);
      state = AsyncData((state.value ?? s).refreshedWith(p.items, p.nextCursor, p.counts, _id));
    } catch (_) {
      // Keep what is on screen.
    }
  }

  /// Throws on a fault so the caller can retry the same decision.
  Future<Outcome<PaymentRequest>> decide(String id, PaymentDecision d) async {
    final out = await ref.read(paymentsRepoProvider).decide(id, d);
    if (out is! Refused<PaymentRequest> || out.code != 'amount_changed') await refresh();
    return out;
  }
}

final paymentListProvider =
    AsyncNotifierProvider.autoDispose.family<PaymentListNotifier, PaymentList, PaymentRequestFilters>(
  PaymentListNotifier.new,
  retry: (_, _) => null,
);

/// How many requests wait for approval — the More menu's badge. Null when it
/// can't be read (the badge just doesn't show).
final pendingApprovalsCountProvider = FutureProvider.autoDispose<int?>((ref) async {
  ref.watch(signedInProvider);
  try {
    final p = await ref
        .read(paymentsRepoProvider)
        .list(const PaymentRequestFilters(status: PaymentStatus.pendingApproval));
    return p.counts.pendingApproval;
  } catch (_) {
    return null;
  }
}, retry: (_, _) => null);
