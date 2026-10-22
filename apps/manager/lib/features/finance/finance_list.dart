import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../state/paged.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';

/// A keyset-paged finance list: loading, error with Retry, pull to refresh,
/// more rows when the end comes into view, and one quiet line when a
/// filtered list is empty.
class FinancePagedList<T, C> extends ConsumerWidget {
  const FinancePagedList({
    super.key,
    required this.value,
    required this.onRetry,
    required this.onRefresh,
    required this.onLoadMore,
    required this.itemBuilder,
    required this.emptyText,
    this.header,
  });

  final AsyncValue<Paged<T, C>> value;
  final VoidCallback onRetry;
  final Future<void> Function() onRefresh;
  final VoidCallback onLoadMore;
  final Widget Function(BuildContext, T) itemBuilder;
  final String emptyText;

  /// Rows above the list (filters, totals), scrolling with it.
  final List<Widget> Function(Paged<T, C>? data)? header;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final data = value.value;
    if (data == null) {
      final e = value.error;
      if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
      return ListView(children: [
        ...?header?.call(null),
        if (e != null)
          ErrorRetry(error: e, onRetry: onRetry)
        else
          const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())),
      ]);
    }
    final head = header?.call(data) ?? const <Widget>[];
    final footer = data.hasMore || data.loadingMore || data.loadMoreFailed;
    return NotificationListener<ScrollNotification>(
      onNotification: (n) {
        if (n.metrics.pixels > n.metrics.maxScrollExtent - 400) onLoadMore();
        return false;
      },
      child: RefreshIndicator(
        onRefresh: onRefresh,
        child: ListView.builder(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(bottom: 32),
          itemCount: head.length + (data.items.isEmpty ? 1 : data.items.length) + (footer ? 1 : 0),
          itemBuilder: (context, i) {
            if (i < head.length) return head[i];
            final j = i - head.length;
            if (data.items.isEmpty && j == 0) return EmptyLine(emptyText);
            if (j >= data.items.length) {
              if (data.loadMoreFailed) {
                return Center(child: TextButton(onPressed: onLoadMore, child: const Text('Couldn\'t load more. Retry')));
              }
              return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
            }
            return itemBuilder(context, data.items[j]);
          },
        ),
      ),
    );
  }
}

/// One finance row: a hairline under it, not a box round it.
class FinanceRow extends StatelessWidget {
  const FinanceRow({super.key, required this.child, this.onTap, this.selected = false});
  final Widget child;
  final VoidCallback? onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final body = Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: selected ? c.accentSoft : null,
        border: Border(bottom: BorderSide(color: c.line)),
      ),
      child: child,
    );
    return onTap == null ? body : InkWell(onTap: onTap, child: body);
  }
}

/// A transaction reference shown in full, selectable, with a copy button.
class ReferenceText extends StatelessWidget {
  const ReferenceText(this.reference, {super.key, required this.copyKey, this.prefix = 'Ref '});
  final String reference;
  final Key copyKey;
  final String prefix;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(prefix, style: TextStyle(fontSize: 12.5, color: c.muted)),
        Flexible(child: SelectableText(reference, style: dataStyle(context, size: 12.5))),
        IconButton(
          key: copyKey,
          tooltip: 'Copy reference',
          visualDensity: VisualDensity.compact,
          iconSize: 16,
          icon: const Icon(Icons.copy_rounded),
          onPressed: () async {
            await Clipboard.setData(ClipboardData(text: reference));
            if (context.mounted) showSnack(context, 'Reference copied');
          },
        ),
      ],
    );
  }
}

/// The two-figure line at the top of a list: how many, and how much.
class TotalsLine extends StatelessWidget {
  const TotalsLine({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
        child: Text(text, style: dataStyle(context, size: 13).copyWith(color: context.colors.muted)),
      );
}
