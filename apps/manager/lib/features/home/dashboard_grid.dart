import 'package:flutter/material.dart';

import '../../models/dashboard.dart';
import '../../theme/app_theme.dart';
import 'figure_tile.dart';

export 'figure_tile.dart' show FigureTile;

/// Width at which the grid goes from two columns to four (tablet / landscape).
const wideBreakpoint = 840.0;

/// The dashboard's figures in the document's order: two to a row on a phone,
/// four at [wideBreakpoint] and wider. Rows size to their tallest tile, so a
/// tile with a note never leaves its neighbour short.
class DashboardGrid extends StatelessWidget {
  const DashboardGrid({super.key, required this.data, required this.onOpen, this.canOpen});

  final DashboardData data;

  /// Called with the tile's target path (e.g. `/orders?status=pending`).
  final void Function(String path) onOpen;

  /// Whether this person may open a tile's target screen; null = all of them.
  final bool Function(FigureKey figure)? canOpen;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, box) {
      final columns = box.maxWidth >= wideBreakpoint ? 4 : 2;
      final rows = <Widget>[];
      for (var i = 0; i < data.order.length; i += columns) {
        final slice = data.order.skip(i).take(columns).toList();
        rows.add(IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var j = 0; j < columns; j++) ...[
                if (j > 0) const SizedBox(width: 10),
                Expanded(
                  child: j < slice.length
                      ? FigureTile(
                          figure: slice[j],
                          value: data.figures[slice[j]],
                          unavailable: data.unavailable.contains(slice[j]),
                          onTap: canOpen == null || canOpen!(slice[j]) ? () => onOpen(slice[j].target) : null,
                        )
                      : const SizedBox.shrink(),
                ),
              ],
            ],
          ),
        ));
      }
      return Column(
        children: [
          for (var r = 0; r < rows.length; r++) ...[
            if (r > 0) const SizedBox(height: 10),
            rows[r],
          ],
        ],
      );
    });
  }
}

/// Placeholder tiles while the first load is on its way.
class DashboardSkeleton extends StatelessWidget {
  const DashboardSkeleton({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return LayoutBuilder(builder: (context, box) {
      final columns = box.maxWidth >= wideBreakpoint ? 4 : 2;
      final width = (box.maxWidth - 10 * (columns - 1)) / columns;
      return Wrap(
        spacing: 10,
        runSpacing: 10,
        children: [
          for (var i = 0; i < 8; i++)
            Container(
              width: width,
              height: 92,
              decoration: BoxDecoration(
                color: c.surface2,
                borderRadius: BorderRadius.circular(radiusBlock),
              ),
            ),
        ],
      );
    });
  }
}
