/// The rows of a keyset-paged list loaded so far, its next cursor, and the
/// per-list counts the server sends with every page.
class Paged<T, C> {
  const Paged({
    required this.items,
    required this.counts,
    this.nextCursor,
    this.firstPageCount,
    this.loadingMore = false,
    this.loadMoreFailed = false,
  });

  /// Page one, as a fresh list.
  factory Paged.first(List<T> items, String? next, C counts) =>
      Paged(items: items, counts: counts, nextCursor: next, firstPageCount: items.length);

  final List<T> items;
  final C counts;
  final String? nextCursor;

  /// How many of [items] came on page one; the rest came from later pages.
  final int? firstPageCount;
  final bool loadingMore;
  final bool loadMoreFailed;

  bool get hasMore => nextCursor != null;
  int get _first => firstPageCount ?? items.length;

  Paged<T, C> copyWith({
    List<T>? items,
    C? counts,
    Object? nextCursor = _keep,
    int? firstPageCount,
    bool? loadingMore,
    bool? loadMoreFailed,
  }) =>
      Paged(
        items: items ?? this.items,
        counts: counts ?? this.counts,
        nextCursor: identical(nextCursor, _keep) ? this.nextCursor : nextCursor as String?,
        firstPageCount: firstPageCount ?? this.firstPageCount,
        loadingMore: loadingMore ?? this.loadingMore,
        loadMoreFailed: loadMoreFailed ?? this.loadMoreFailed,
      );

  /// Appends [more] (a later page), skipping rows already shown.
  Paged<T, C> append(List<T> more, String? next, String Function(T) id) {
    final seen = {for (final x in items) id(x)};
    return copyWith(
      items: [...items, ...more.where((x) => !seen.contains(id(x)))],
      nextCursor: next,
      firstPageCount: _first,
      loadingMore: false,
    );
  }

  /// A refreshed page one laid over what is loaded. Page one is replaced
  /// outright; rows the manager scrolled to on later pages stay — matched by
  /// id, so new rows arriving on top can never push a loaded row out — and so
  /// does the cursor that continues after them.
  Paged<T, C> refreshedWith(List<T> first, String? firstNext, C counts, String Function(T) id) {
    final fresh = {for (final x in first) id(x)};
    final later = items.skip(_first).where((x) => !fresh.contains(id(x))).toList();
    return Paged(
      items: [...first, ...later],
      counts: counts,
      nextCursor: later.isEmpty ? firstNext : nextCursor,
      firstPageCount: first.length,
    );
  }
}

const _keep = Object();
