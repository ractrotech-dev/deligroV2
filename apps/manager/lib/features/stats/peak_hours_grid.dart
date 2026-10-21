import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../theme/app_theme.dart';

/// "8 PM".
String hourLabel(int hour) => DateFormat('h a').format(DateTime(2000, 1, 1, hour));

/// §2.8 — orders by weekday (rows, Monday first) and hour of day (columns):
/// the darker the cell, the busier that hour.
class PeakHoursGrid extends ConsumerWidget {
  const PeakHoursGrid({super.key, required this.grid});
  final List<List<int>> grid;

  static const _daysEn = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final busiest = grid.fold<int>(0, (m, row) => row.fold<int>(m, (a, v) => v > a ? v : a));
    return Column(
      children: [
        for (var d = 0; d < 7; d++)
          Padding(
            padding: const EdgeInsets.only(bottom: 3),
            child: Row(
              children: [
                SizedBox(
                  width: 34,
                  child: Text(_daysEn[d], style: TextStyle(fontSize: 10.5, color: c.muted)),
                ),
                for (var h = 0; h < 24; h++)
                  Expanded(
                    child: Tooltip(
                      message: '${_daysEn[d]} ${hourLabel(h)}: ${d < grid.length && h < grid[d].length ? grid[d][h] : 0}',
                      child: Container(
                        key: const ValueKey('peak-cell'),
                        height: 16,
                        margin: const EdgeInsets.symmetric(horizontal: 0.75),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(3),
                          color: _shade(c, d < grid.length && h < grid[d].length ? grid[d][h] : 0, busiest),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        Row(
          children: [
            const SizedBox(width: 34),
            for (final h in const [0, 6, 12, 18])
              Expanded(
                child: Text(hourLabel(h), style: TextStyle(fontSize: 10, color: c.muted)),
              ),
          ],
        ),
      ],
    );
  }

  Color _shade(AppColors c, int v, int busiest) {
    if (v == 0 || busiest == 0) return c.surface2;
    return c.accent.withValues(alpha: 0.15 + 0.85 * (v / busiest));
  }
}
