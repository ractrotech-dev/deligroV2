import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/money.dart';
import '../../models/earnings.dart';
import '../../state/earnings.dart';
import '../../state/providers.dart' show riderKeyProvider;
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'earnings_widgets.dart';

/// "Complete 10 deliveries today → ₹100 bonus".
String incentiveRuleText(IncentiveProgress i) {
  final unit = i.target == 1 ? 'delivery' : 'deliveries';
  return 'Complete ${i.target} $unit ${i.daily ? 'today' : 'this week'} → ${money(i.bonus)} bonus';
}

/// Every incentive rule in force, with the rider's progress this day or week.
class IncentivesScreen extends ConsumerWidget {
  const IncentivesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final rules = ref.watch(incentivesProvider(ref.watch(riderKeyProvider)));
    return Scaffold(
      appBar: AppBar(title: const Text('Incentives & targets')),
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(incentivesProvider);
            await ref
                .read(incentivesProvider(ref.read(riderKeyProvider)).future)
                .then<void>((_) {}, onError: (_) {});
          },
          child: AsyncBody<List<IncentiveProgress>>(
            value: rules,
            onRetry: () => ref.invalidate(incentivesProvider),
            builder: (list) => list.isEmpty
                ? ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    children: [
                      ConstrainedBox(
                        constraints: const BoxConstraints(minHeight: 420),
                        child: const EmptyState(
                          icon: Icons.emoji_events_outlined,
                          title: 'No targets right now',
                          body: 'Bonus targets show up here when Deligro runs them.',
                        ),
                      ),
                    ],
                  )
                : ListView.separated(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                    itemCount: list.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 12),
                    itemBuilder: (_, i) => _IncentiveCard(incentive: list[i]),
                  ),
          ),
        ),
      ),
    );
  }
}

class _IncentiveCard extends StatelessWidget {
  const _IncentiveCard({required this.incentive});

  final IncentiveProgress incentive;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final i = incentive;
    Widget info(IconData icon, String text) => Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 18, color: c.muted),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: TextStyle(color: c.muted, fontSize: 14, height: 1.3),
            ),
          ),
        ],
      ),
    );
    return Panel(
      key: Key('incentive-${i.ruleId}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  i.name,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              if (i.earned) ...[
                const SizedBox(width: 8),
                StatusChip('Earned', fg: c.green, bg: c.greenSoft),
              ],
            ],
          ),
          const SizedBox(height: 4),
          Text(
            incentiveRuleText(i),
            style: TextStyle(color: c.ink, fontSize: 15, height: 1.3),
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: LinearProgressIndicator(
              value: i.fraction,
              minHeight: 10,
              color: i.earned ? c.green : c.accent,
              backgroundColor: c.surface2,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            '${i.done} of ${i.target}',
            style: dataStyle(context, size: 14, weight: FontWeight.w700),
          ),
          info(
            Icons.schedule_rounded,
            i.window == null ? 'All day' : '${i.window} (IST)',
          ),
          info(
            Icons.event_outlined,
            i.endsOn == null ? 'No end date' : 'Ends ${formatDay(i.endsOn)}',
          ),
        ],
      ),
    );
  }
}
