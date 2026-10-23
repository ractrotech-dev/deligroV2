import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'paged.dart';
import 'providers.dart';

/// One keyset page as the list notifier needs it.
typedef PageOf<T, C> = ({List<T> items, String? next, C counts});

/// A keyset-paged list: page one on build, more on [loadMore], page one laid
/// over what is loaded on [refresh] (rows merged by id, never by position).
/// Subclasses say how to fetch a page and what a row's id is.
abstract class PagedListNotifier<T, C> extends AsyncNotifier<Paged<T, C>> {
  Future<PageOf<T, C>> fetch({String? cursor});
  String idOf(T row);

  @override
  Future<Paged<T, C>> build() async {
    ref.watch(signedInProvider);
    final p = await fetch();
    return Paged.first(p.items, p.next, p.counts);
  }

  Future<void> loadMore() async {
    final s = state.value;
    if (s == null || !s.hasMore || s.loadingMore) return;
    state = AsyncData(s.copyWith(loadingMore: true, loadMoreFailed: false));
    try {
      final p = await fetch(cursor: s.nextCursor);
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
      final p = await fetch();
      state = AsyncData((state.value ?? s).refreshedWith(p.items, p.next, p.counts, idOf));
    } catch (_) {
      // A failed background refresh keeps what is on screen.
    }
  }
}
