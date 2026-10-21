import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/i18n.dart';
import '../../models/dashboard.dart';
import '../../theme/app_theme.dart';

/// One dashboard figure: the document's label, the number in JetBrains Mono,
/// and — for a figure the platform cannot count yet — "—" with a note saying
/// what brings it. The whole tile opens the list behind the number.
class FigureTile extends ConsumerWidget {
  const FigureTile({super.key, required this.figure, required this.value, required this.unavailable, required this.onTap});

  final FigureKey figure;
  final num? value;
  final bool unavailable;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final label = tr(ref, figure.en, figure.hi);
    final shown = unavailable || value == null ? '—' : (figure.money ? rupees(value!) : count(value!));
    return Semantics(
      button: true,
      label: '$label: $shown',
      child: Material(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        child: InkWell(
          key: Key('figure-${figure.key}'),
          borderRadius: BorderRadius.circular(radiusBlock),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 92),
            padding: const EdgeInsets.fromLTRB(12, 11, 12, 12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(radiusBlock),
              border: Border.all(color: c.line),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: c.muted, height: 1.25),
                ),
                const SizedBox(height: 8),
                FittedBox(
                  fit: BoxFit.scaleDown,
                  alignment: Alignment.centerLeft,
                  child: Text(shown, style: dataStyle(context, size: 22, weight: FontWeight.w700)),
                ),
                if (unavailable) ...[
                  const SizedBox(height: 4),
                  Text(
                    tr(ref, figure.pendingEn, figure.pendingHi),
                    style: TextStyle(fontSize: 11.5, color: c.muted, height: 1.25),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
