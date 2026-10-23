import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/money.dart';
import '../../state/cash.dart';
import '../../state/providers.dart' show riderKeyProvider;
import '../../theme/app_theme.dart';
import 'cash_screen.dart' show cashPath;

/// The cash the rider holds, or null while unknown, on error, or when none.
/// Home and More show cash only when there is some; a failed or missing cash
/// service never gets in the way of either screen.
int? pendingCash(WidgetRef ref) {
  final s = ref.watch(cashSummaryProvider(ref.watch(riderKeyProvider))).value;
  if (s == null || s.pending <= 0) return null;
  return s.pending;
}

/// Home: "Cash in hand ₹X" under the money row when the rider holds cash.
/// It is a reminder of money that belongs to Deligro, not one of the day's
/// figures, and says so.
class CashInHandStrip extends ConsumerWidget {
  const CashInHandStrip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final summary = ref.watch(cashSummaryProvider(ref.watch(riderKeyProvider))).value;
    if (summary == null || summary.pending <= 0) return const SizedBox.shrink();
    final c = context.colors;
    final tone = summary.over ? c.deal : c.ink;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Material(
        color: summary.over ? c.dealSoft : c.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusBlock),
          side: BorderSide(color: summary.over ? c.deal : c.line),
        ),
        child: InkWell(
          key: const Key('home-cash-strip'),
          customBorder: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radiusBlock),
          ),
          onTap: () => context.push(cashPath),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: Row(
              children: [
                Icon(Icons.payments_outlined, color: tone),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Cash in hand ${money(summary.pending)}',
                        key: const Key('home-cash-amount'),
                        style: TextStyle(
                          color: tone,
                          fontSize: 16,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Not your earnings',
                        style: TextStyle(color: c.muted, fontSize: 13),
                      ),
                    ],
                  ),
                ),
                Icon(Icons.chevron_right_rounded, color: c.muted),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
