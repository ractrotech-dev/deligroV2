import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api.dart';
import '../state/paged.dart';
import '../state/session.dart';
import '../theme/app_theme.dart';
import 'async_view.dart';

/// The body of a paged list: skeletons while page one loads, error with
/// Retry, the full-screen empty state for an empty section or one quiet line
/// for a filtered list that came back empty (§18.7), pull-to-refresh, and
/// more rows as the manager nears the bottom.
class PagedListView<T, C> extends ConsumerStatefulWidget {
  const PagedListView({
    super.key,
    required this.value,
    required this.itemBuilder,
    required this.onRetry,
    required this.onRefresh,
    required this.onLoadMore,
    required this.empty,
    this.narrowed = false,
    this.filteredEmptyText = 'Nothing matches these filters.',
    this.skeletonHeight = 76,
    this.header,
    this.padding = const EdgeInsets.fromLTRB(16, 4, 16, 96),
  });

  final AsyncValue<Paged<T, C>> value;
  final Widget Function(BuildContext context, T row) itemBuilder;
  final VoidCallback onRetry;
  final Future<void> Function() onRefresh;
  final VoidCallback onLoadMore;

  /// Shown when the whole section is empty (not narrowed).
  final Widget empty;
  final bool narrowed;
  final String filteredEmptyText;
  final double skeletonHeight;

  /// Scrolls with the rows (summary figures above a list, for instance).
  final Widget? header;
  final EdgeInsets padding;

  @override
  ConsumerState<PagedListView<T, C>> createState() => _PagedListViewState<T, C>();
}

class _PagedListViewState<T, C> extends ConsumerState<PagedListView<T, C>> {
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (!_scroll.hasClients) return;
      final p = _scroll.position;
      if (p.maxScrollExtent > 0 && p.pixels >= p.maxScrollExtent * 0.8) widget.onLoadMore();
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final data = widget.value.value;
    if (data == null) {
      if (widget.value.hasError) {
        final e = widget.value.error!;
        if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
        return ErrorRetry(error: e, onRetry: widget.onRetry);
      }
      return ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        itemCount: 6,
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (_, _) => Container(
          height: widget.skeletonHeight,
          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
        ),
      );
    }

    final header = widget.header;
    if (data.items.isEmpty) {
      return RefreshIndicator(
        onRefresh: widget.onRefresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            ?header,
            if (widget.narrowed) EmptyLine(widget.filteredEmptyText) else widget.empty,
          ],
        ),
      );
    }

    final footer = data.hasMore || data.loadingMore || data.loadMoreFailed;
    final lead = header == null ? 0 : 1;
    return RefreshIndicator(
      onRefresh: widget.onRefresh,
      child: ListView.separated(
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: widget.padding,
        itemCount: lead + data.items.length + (footer ? 1 : 0),
        separatorBuilder: (_, i) => i < lead ? const SizedBox.shrink() : const SizedBox(height: 10),
        itemBuilder: (context, i) {
          if (i < lead) return header!;
          final r = i - lead;
          if (r == data.items.length) {
            if (data.loadMoreFailed) {
              return Center(
                child: TextButton(onPressed: widget.onLoadMore, child: const Text("Couldn't load more — tap to retry")),
              );
            }
            return const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.4))),
            );
          }
          return widget.itemBuilder(context, data.items[r]);
        },
      ),
    );
  }
}

/// A whole section with nothing in it yet: an icon, a title and a line.
class EmptySection extends StatelessWidget {
  const EmptySection({super.key, required this.icon, required this.title, required this.text});
  final IconData icon;
  final String title;
  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(32, 80, 32, 32),
      child: Column(
        children: [
          Icon(icon, size: 44, color: c.muted),
          const SizedBox(height: 12),
          Text(title, style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)),
          const SizedBox(height: 6),
          Text(text, textAlign: TextAlign.center, style: TextStyle(color: c.muted, fontSize: 14)),
        ],
      ),
    );
  }
}

/// A row of choice chips with counts, scrolling sideways.
class CountChips<S> extends StatelessWidget {
  const CountChips({
    super.key,
    required this.options,
    required this.selected,
    required this.onSelected,
    this.keyPrefix = 'chip',
    this.allLabel,
  });

  /// (value, label, count or null).
  final List<(S, String, int?)> options;
  final S? selected;
  final ValueChanged<S?> onSelected;
  final String keyPrefix;

  /// When set, an "All" chip first that selects null.
  final String? allLabel;

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
        child: Row(
          children: [
            if (allLabel != null)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(
                  key: Key('$keyPrefix-all'),
                  label: Text(allLabel!),
                  selected: selected == null,
                  onSelected: (_) => onSelected(null),
                ),
              ),
            for (final (value, label, count) in options)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: ChoiceChip(
                  key: Key('$keyPrefix-${value is Enum ? value.name : value}'),
                  label: Text(count == null ? label : '$label ($count)'),
                  selected: selected == value,
                  onSelected: (_) => onSelected(value),
                ),
              ),
          ],
        ),
      );
}

/// A card for one row in a list: tap target, surface, hairline border.
class RowCard extends StatelessWidget {
  const RowCard({super.key, required this.child, this.onTap, this.selected = false});
  final Widget child;
  final VoidCallback? onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Material(
      color: selected ? c.accentSoft : c.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radiusBlock),
        side: BorderSide(color: selected ? c.accent : c.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(onTap: onTap, child: Padding(padding: const EdgeInsets.all(14), child: child)),
    );
  }
}
