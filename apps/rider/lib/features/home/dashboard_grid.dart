import 'package:flutter/material.dart';

import '../../core/money.dart';
import '../../models/dashboard.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../earnings/earnings_widgets.dart' show MoneyTile;
import '../history/history_screen.dart' show notDeliveredWire;

/// One count on Home (figures 1-6): a tinted tile that taps through.
class CountTile extends StatelessWidget {
  const CountTile({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    required this.tint,
    required this.iconColor,
    this.subtitle,
    this.onTap,
  });

  final String label;
  final int value;
  final IconData icon;

  /// The tile's wash (a token at low strength), and the icon's colour.
  final Color tint;
  final Color iconColor;
  final String? subtitle;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      button: onTap != null,
      label: '$label, $value${subtitle == null ? '' : ', $subtitle'}',
      excludeSemantics: true,
      child: Material(
        color: Color.alphaBlend(tint, c.surface),
        borderRadius: BorderRadius.circular(radiusBlock),
        child: InkWell(
          borderRadius: BorderRadius.circular(radiusBlock),
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 96),
            padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(radiusBlock),
              border: Border.all(color: c.line),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.only(top: 1),
                      child: Icon(icon, size: 18, color: iconColor),
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Text(
                        label,
                        style: TextStyle(
                          color: c.muted,
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          height: 1.2,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  '$value',
                  style: dataStyle(context, size: 28, weight: FontWeight.w800),
                ),
                if (subtitle != null)
                  Text(
                    subtitle!,
                    style: TextStyle(
                      color: c.muted,
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Figures 1-6 in two columns. [toJobs] and [toHistory] are the taps; a null
/// [toHistory] (History switched off) leaves the three History tiles plain.
class CountGrid extends StatelessWidget {
  const CountGrid({
    super.key,
    required this.today,
    required this.toJobs,
    required this.toHistory,
  });

  final DashToday today;
  final VoidCallback toJobs;
  final void Function(String? outcome)? toHistory;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final history = toHistory;
    Widget pair(Widget a, Widget b) => IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(child: a),
          const SizedBox(width: 10),
          Expanded(child: b),
        ],
      ),
    );
    return Column(
      children: [
        pair(
          CountTile(
            key: const Key('tile-deliveries'),
            label: "Today's deliveries",
            value: today.deliveries,
            subtitle: 'Accepted today',
            icon: Icons.local_shipping_outlined,
            tint: c.surface2.withValues(alpha: 0.6),
            iconColor: c.ink,
            // Not a way into History (ruling P4-R-APP1, Home and History never
            // disagree): this counts jobs accepted today, still running ones
            // too, while History lists finished jobs by the day they ended,
            // and its filter cannot say "accepted today".
            onTap: null,
          ),
          CountTile(
            key: const Key('tile-pending'),
            label: 'Pending',
            value: today.pending,
            icon: Icons.notifications_active_outlined,
            tint: c.accent.withValues(alpha: 0.14),
            iconColor: c.accentInk,
            onTap: toJobs,
          ),
        ),
        const SizedBox(height: 10),
        pair(
          CountTile(
            key: const Key('tile-accepted'),
            label: 'Accepted',
            value: today.accepted,
            icon: Icons.assignment_turned_in_outlined,
            tint: c.blue.withValues(alpha: 0.14),
            iconColor: c.blue,
            onTap: toJobs,
          ),
          CountTile(
            key: const Key('tile-picked-up'),
            label: 'Picked up',
            value: today.pickedUp,
            icon: Icons.shopping_bag_outlined,
            tint: c.pop.withValues(alpha: 0.22),
            iconColor: dark ? c.pop : c.popInk,
            onTap: toJobs,
          ),
        ),
        const SizedBox(height: 10),
        pair(
          CountTile(
            key: const Key('tile-completed'),
            label: 'Completed',
            value: today.completed,
            icon: Icons.check_circle_outline_rounded,
            tint: c.green.withValues(alpha: 0.14),
            iconColor: c.green,
            onTap: history == null ? null : () => history('delivered'),
          ),
          CountTile(
            key: const Key('tile-cancelled'),
            label: 'Cancelled',
            value: today.cancelled,
            icon: Icons.cancel_outlined,
            tint: c.deal.withValues(alpha: 0.12),
            iconColor: c.deal,
            subtitle: today.failed > 0 ? '${today.failed} failed' : null,
            onTap: history == null ? null : () => history(notDeliveredWire),
          ),
        ),
      ],
    );
  }
}

/// What the Earnings tab says under the same figures: riders are on a salary,
/// so these are not pay per delivery.
const _salaryCaption = 'Salary, bonuses and incentives, less deductions';

/// Figures 7-9 from the recorded ledger: today's earnings, the total, and
/// what is still to be paid (negative: the rider owes Deligro).
class MoneyRow extends StatelessWidget {
  const MoneyRow({super.key, required this.figures});

  final DashMoney figures;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final owing = figures.pending < 0;
    return Column(
      children: [
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: MoneyTile(
                  key: const Key('tile-earnings-today'),
                  label: "Today's earnings",
                  value: money(figures.today),
                  caption: _salaryCaption,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: MoneyTile(
                  key: const Key('tile-earnings-total'),
                  label: 'Total earnings',
                  value: money(figures.total),
                  caption: _salaryCaption,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        SizedBox(
          width: double.infinity,
          child: MoneyTile(
            key: const Key('tile-earnings-pending'),
            label: 'Pending payments',
            value: money(figures.pending),
            valueColor: owing ? c.deal : null,
            caption: owing
                ? 'You owe Deligro this — it comes off your next payout'
                : 'Earned and waiting for your next payout',
            captionColor: owing ? c.deal : null,
          ),
        ),
      ],
    );
  }
}

/// Figure 12: incentives earned this week and the nearest target's progress.
class IncentivesCard extends StatelessWidget {
  const IncentivesCard({super.key, required this.earned, required this.target});

  final double earned;
  final NearestTarget? target;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final t = target;
    return Panel(
      key: const Key('incentives-card'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Incentives this week',
            style: TextStyle(
              color: c.muted,
              fontSize: 13,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            money(earned),
            style: dataStyle(context, size: 24, weight: FontWeight.w800),
          ),
          const SizedBox(height: 12),
          if (t == null)
            Row(
              children: [
                Text(
                  '—',
                  style: dataStyle(context, size: 16, weight: FontWeight.w700),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'No target to work towards right now',
                    style: TextStyle(color: c.muted, fontSize: 14, height: 1.3),
                  ),
                ),
              ],
            )
          else ...[
            Row(
              children: [
                Expanded(
                  child: Text(
                    t.name,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  '${money(t.bonus)} bonus',
                  style: TextStyle(
                    color: c.green,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: LinearProgressIndicator(
                value: t.fraction,
                minHeight: 10,
                color: t.fraction >= 1 ? c.green : c.accent,
                backgroundColor: c.surface2,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              '${t.done} of ${t.target}',
              style: dataStyle(context, size: 14, weight: FontWeight.w700),
            ),
          ],
        ],
      ),
    );
  }
}
