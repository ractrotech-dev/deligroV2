import 'package:flutter/material.dart' show DateTimeRange;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/format.dart';
import '../models/finance.dart';
import '../models/rider.dart' show ymd;
import '../models/settlement.dart';
import '../widgets/zone_picker.dart';
import 'paged.dart';
import 'providers.dart';

/// The Finance tab's period (§7): the chips above the figures.
enum FinancePeriod {
  today('Today'),
  week('7 days'),
  days30('30 days'),
  thisMonth('This month'),
  custom('Custom');

  const FinancePeriod(this.label);
  final String label;
}

class FinanceRange {
  const FinanceRange(this.period, [this.custom]);
  final FinancePeriod period;
  final DateTimeRange? custom;

  /// Inclusive IST dates. Ranges end today (India time) whatever the phone's
  /// own zone is.
  ({String from, String to}) dates([DateTime? now]) {
    final today = istToday(now);
    final (DateTime f, DateTime t) = switch (period) {
      FinancePeriod.today => (today, today),
      FinancePeriod.week => (today.subtract(const Duration(days: 6)), today),
      FinancePeriod.days30 => (today.subtract(const Duration(days: 29)), today),
      FinancePeriod.thisMonth => (DateTime(today.year, today.month, 1), today),
      FinancePeriod.custom => (custom?.start ?? today.subtract(const Duration(days: 29)), custom?.end ?? today),
    };
    return (from: ymd(f), to: ymd(t));
  }
}

class FinanceRangeNotifier extends Notifier<FinanceRange> {
  @override
  FinanceRange build() => const FinanceRange(FinancePeriod.days30);

  void set(FinancePeriod p) => state = FinanceRange(p, state.custom);
  void setCustom(DateTimeRange r) => state = FinanceRange(FinancePeriod.custom, r);
}

final financeRangeProvider = NotifierProvider<FinanceRangeNotifier, FinanceRange>(FinanceRangeNotifier.new);

/// The period and zone every finance screen asks for.
final financeQueryProvider = Provider<FinanceQuery>((ref) {
  final d = ref.watch(financeRangeProvider).dates();
  return FinanceQuery(from: d.from, to: d.to, zoneId: ref.watch(activeZoneProvider)?.id);
});

final financeOverviewProvider = FutureProvider.autoDispose.family<FinanceOverview, FinanceQuery>((ref, q) {
  ref.watch(signedInProvider);
  return ref.read(financeRepoProvider).overview(q);
}, retry: (_, _) => null);

// ── Paged lists ──────────────────────────────────────────────────────────────

/// A keyset-paged finance list: first page, more, refresh merged by id.
abstract class _PagedNotifier<T, C> extends AsyncNotifier<Paged<T, C>> {
  Future<({List<T> items, String? next, C counts})> fetch(String? cursor);
  String idOf(T x);

  @override
  Future<Paged<T, C>> build() async {
    ref.watch(signedInProvider);
    final p = await fetch(null);
    return Paged.first(p.items, p.next, p.counts);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final p = await fetch(s.nextCursor);
      state = AsyncData((state.value ?? s).append(p.items, p.next, idOf));
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
      final p = await fetch(null);
      state = AsyncData((state.value ?? s).refreshedWith(p.items, p.next, p.counts, idOf));
    } catch (_) {
      // Keep what is on screen.
    }
  }
}

typedef DuesArgs = ({String? zoneId, bool delayedOnly});

class VendorDuesNotifier extends _PagedNotifier<VendorDue, DueTotals> {
  VendorDuesNotifier(this.args);
  final DuesArgs args;

  @override
  String idOf(VendorDue x) => x.vendor.id;

  @override
  Future<({List<VendorDue> items, String? next, DueTotals counts})> fetch(String? cursor) async {
    final p = await ref.read(financeRepoProvider).vendorDues(zoneId: args.zoneId, delayedOnly: args.delayedOnly, cursor: cursor);
    return (items: p.items, next: p.nextCursor, counts: DueTotals(payable: p.totalPayable, count: p.count));
  }
}

final vendorDuesProvider =
    AsyncNotifierProvider.autoDispose.family<VendorDuesNotifier, Paged<VendorDue, DueTotals>, DuesArgs>(
  VendorDuesNotifier.new,
  retry: (_, _) => null,
);

class RiderDuesNotifier extends _PagedNotifier<RiderDue, DueTotals> {
  RiderDuesNotifier(this.args);
  final DuesArgs args;

  @override
  String idOf(RiderDue x) => x.rider.id;

  @override
  Future<({List<RiderDue> items, String? next, DueTotals counts})> fetch(String? cursor) async {
    final p = await ref.read(financeRepoProvider).riderDues(zoneId: args.zoneId, delayedOnly: args.delayedOnly, cursor: cursor);
    return (items: p.items, next: p.nextCursor, counts: DueTotals(payable: p.totalPayable, count: p.count));
  }
}

final riderDuesProvider =
    AsyncNotifierProvider.autoDispose.family<RiderDuesNotifier, Paged<RiderDue, DueTotals>, DuesArgs>(
  RiderDuesNotifier.new,
  retry: (_, _) => null,
);

typedef IssueArgs = ({FinanceQuery q, FinanceIssueType? type});

class IssuesNotifier extends _PagedNotifier<FinanceIssue, Map<FinanceIssueType, int>> {
  IssuesNotifier(this.args);
  final IssueArgs args;

  @override
  String idOf(FinanceIssue x) => '${x.type.wire}:${x.subject.kind.name}:${x.subject.id}';

  @override
  Future<({List<FinanceIssue> items, String? next, Map<FinanceIssueType, int> counts})> fetch(String? cursor) async {
    final p = await ref.read(financeRepoProvider).issues(args.q, type: args.type, cursor: cursor);
    return (items: p.items, next: p.nextCursor, counts: p.counts);
  }
}

final financeIssuesProvider =
    AsyncNotifierProvider.autoDispose.family<IssuesNotifier, Paged<FinanceIssue, Map<FinanceIssueType, int>>, IssueArgs>(
  IssuesNotifier.new,
  retry: (_, _) => null,
);

class SettlementsNotifier extends _PagedNotifier<SettlementSummary, DueTotals> {
  SettlementsNotifier(this.filters);
  final SettlementFilters filters;

  @override
  String idOf(SettlementSummary x) => x.id;

  @override
  Future<({List<SettlementSummary> items, String? next, DueTotals counts})> fetch(String? cursor) async {
    final p = await ref.read(financeRepoProvider).settlements(filters, cursor: cursor);
    return (items: p.items, next: p.nextCursor, counts: DueTotals(payable: p.totalNetPayable, count: p.count));
  }
}

final settlementsProvider =
    AsyncNotifierProvider.autoDispose.family<SettlementsNotifier, Paged<SettlementSummary, DueTotals>, SettlementFilters>(
  SettlementsNotifier.new,
  retry: (_, _) => null,
);

final settlementDetailProvider = FutureProvider.autoDispose.family<SettlementDetail, String>((ref, id) {
  ref.watch(signedInProvider);
  return ref.read(financeRepoProvider).settlement(id);
}, retry: (_, _) => null);

class RiderPayoutsNotifier extends _PagedNotifier<RiderPayoutItem, DueTotals> {
  RiderPayoutsNotifier(this.q);
  final FinanceQuery q;

  @override
  String idOf(RiderPayoutItem x) => x.payout.id;

  @override
  Future<({List<RiderPayoutItem> items, String? next, DueTotals counts})> fetch(String? cursor) async {
    final p = await ref.read(financeRepoProvider).riderPayouts(q, cursor: cursor);
    return (items: p.items, next: p.nextCursor, counts: DueTotals(payable: p.totalAmount, count: p.count));
  }
}

final riderPayoutsProvider =
    AsyncNotifierProvider.autoDispose.family<RiderPayoutsNotifier, Paged<RiderPayoutItem, DueTotals>, FinanceQuery>(
  RiderPayoutsNotifier.new,
  retry: (_, _) => null,
);

typedef RefundArgs = ({FinanceQuery q, RefundStatus? status});

class RefundsNotifier extends _PagedNotifier<RefundItem, int> {
  RefundsNotifier(this.args);
  final RefundArgs args;

  @override
  String idOf(RefundItem x) => x.id;

  @override
  Future<({List<RefundItem> items, String? next, int counts})> fetch(String? cursor) async {
    final p = await ref.read(financeRepoProvider).refunds(args.q, status: args.status, cursor: cursor);
    return (items: p.items, next: p.nextCursor, counts: p.pendingCount);
  }
}

final refundsProvider = AsyncNotifierProvider.autoDispose.family<RefundsNotifier, Paged<RefundItem, int>, RefundArgs>(
  RefundsNotifier.new,
  retry: (_, _) => null,
);

typedef ReconArgs = ({FinanceQuery q, ReconSection section, String? state});

/// One reconciliation section, keyset-paged: [loadMore] appends the next page
/// so every unmatched order can be listed.
class ReconciliationNotifier extends AsyncNotifier<Reconciliation> {
  ReconciliationNotifier(this.args);
  final ReconArgs args;
  bool _loading = false;

  @override
  Future<Reconciliation> build() {
    ref.watch(signedInProvider);
    return ref.read(financeRepoProvider).reconciliation(args.q, args.section, state: args.state);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || s.nextCursor == null || _loading) return;
    _loading = true;
    try {
      final next = await ref.read(financeRepoProvider).reconciliation(args.q, args.section, state: args.state, cursor: s.nextCursor);
      state = AsyncData((state.value ?? s).followedBy(next));
    } finally {
      _loading = false;
    }
  }
}

final reconciliationProvider =
    AsyncNotifierProvider.autoDispose.family<ReconciliationNotifier, Reconciliation, ReconArgs>(
  ReconciliationNotifier.new,
  retry: (_, _) => null,
);
