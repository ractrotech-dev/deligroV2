import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/audit.dart';
import 'paged.dart';
import 'providers.dart';

typedef AuditList = Paged<AuditEntry, int>;

/// The audit log for one set of filters, newest first, keyset-paged.
class AuditListNotifier extends AsyncNotifier<AuditList> {
  AuditListNotifier(this.filters);
  final AuditFilters filters;

  static String _id(AuditEntry e) => '${e.id}';

  @override
  Future<AuditList> build() async {
    ref.watch(signedInProvider);
    final p = await ref.read(auditRepoProvider).list(filters);
    return Paged.first(p.items, p.nextCursor, 0);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final p = await ref.read(auditRepoProvider).list(filters, cursor: s.nextCursor);
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
      final p = await ref.read(auditRepoProvider).list(filters);
      state = AsyncData((state.value ?? s).refreshedWith(p.items, p.nextCursor, 0, _id));
    } catch (_) {
      // Keep what is on screen.
    }
  }
}

final auditListProvider = AsyncNotifierProvider.autoDispose.family<AuditListNotifier, AuditList, AuditFilters>(
  AuditListNotifier.new,
  retry: (_, _) => null,
);

/// The catalog of recorded actions, for labels and the filter sheet. Empty
/// on failure — the log still reads, with codes in place of labels.
final auditActionsProvider = FutureProvider.autoDispose<List<AuditActionDef>>(
  (ref) async {
    ref.watch(signedInProvider);
    try {
      return await ref.read(auditRepoProvider).actions();
    } catch (_) {
      return const [];
    }
  },
  retry: (_, _) => null,
);

final auditEntryProvider = FutureProvider.autoDispose.family<AuditEntryDetail, int>(
  (ref, id) {
    ref.watch(signedInProvider);
    return ref.read(auditRepoProvider).entry(id);
  },
  retry: (_, _) => null,
);
