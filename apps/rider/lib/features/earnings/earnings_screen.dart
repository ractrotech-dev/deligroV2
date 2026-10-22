import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/money.dart';
import '../../models/earnings.dart';
import '../../models/rider_me.dart';
import '../../state/earnings.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/rows.dart';
import 'earnings_widgets.dart';
import 'incentives_screen.dart';
import 'payouts_screen.dart';
import 'record_detail_screen.dart';
import 'records_screen.dart';
import 'statement_screen.dart';

/// The Earnings tab and the pages under it. The tab bar stays under every one.
final earningsRoute = GoRoute(
  path: earningsPath,
  builder: (_, _) => const EarningsScreen(),
  routes: [
    GoRoute(path: 'records', builder: (_, _) => const RecordsScreen()),
    GoRoute(
      path: 'record',
      builder: (_, state) {
        final record = state.extra;
        // Opened without a record (a stale link): back to the list.
        return record is EarningRecord
            ? RecordDetailScreen(record: record)
            : const RecordsScreen();
      },
    ),
    GoRoute(path: 'payouts', builder: (_, _) => const PayoutsScreen()),
    GoRoute(path: 'incentives', builder: (_, _) => const IncentivesScreen()),
    GoRoute(path: 'statement', builder: (_, _) => const StatementScreen()),
  ],
);

/// Where a deep link into Earnings goes while the rider's `driver.earnings`
/// switch is off: Home. Null when the page may open.
String? earningsRedirect(String path, RiderMe? me) {
  final inEarnings = path == earningsPath || path.startsWith('$earningsPath/');
  if (inEarnings && me != null && !me.feature(earningsFeature)) return '/home';
  return null;
}

enum _Period { today, week, month, total }

extension on _Period {
  String get tab => switch (this) {
    _Period.today => 'Today',
    _Period.week => 'Week',
    _Period.month => 'Month',
    _Period.total => 'Total',
  };

  String get heading => switch (this) {
    _Period.today => 'Today',
    _Period.week => 'This week',
    _Period.month => 'This month',
    _Period.total => 'All time',
  };

  double of(EarningsSummary s) => switch (this) {
    _Period.today => s.today,
    _Period.week => s.week,
    _Period.month => s.month,
    _Period.total => s.total,
  };
}

/// What the rider has earned and been paid: a period switch, the balance, the
/// breakdown, and the way into the records, payouts, targets and statements.
/// Earnings only; cash collected from customers is never in these figures.
class EarningsScreen extends ConsumerStatefulWidget {
  const EarningsScreen({super.key});

  @override
  ConsumerState<EarningsScreen> createState() => _EarningsScreenState();
}

class _EarningsScreenState extends ConsumerState<EarningsScreen> {
  _Period _period = _Period.today;

  Future<void> _refresh() async {
    ref.invalidate(earningsSummaryProvider);
    await ref
        .read(earningsSummaryProvider.future)
        .then<void>((_) {}, onError: (_) {});
  }

  @override
  Widget build(BuildContext context) {
    final summary = ref.watch(earningsSummaryProvider);
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: _refresh,
          child: AsyncBody<EarningsSummary>(
            value: summary,
            onRetry: () => ref.invalidate(earningsSummaryProvider),
            builder: (s) => _Body(
              summary: s,
              period: _period,
              onPeriod: (p) => setState(() => _period = p),
            ),
          ),
        ),
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({
    required this.summary,
    required this.period,
    required this.onPeriod,
  });

  final EarningsSummary summary;
  final _Period period;
  final ValueChanged<_Period> onPeriod;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = summary;
    final owing = s.pending < 0;
    final last = s.lastPayout;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      children: [
        Text('Earnings', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 14),
        _PeriodSwitch(period: period, onChanged: onPeriod),
        const SizedBox(height: 12),
        Panel(
          key: const Key('earnings-hero'),
          padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                period.heading,
                style: TextStyle(
                  color: c.muted,
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                money(period.of(s)),
                style: dataStyle(context, size: 40, weight: FontWeight.w800),
              ),
              const SizedBox(height: 4),
              Text(
                'Salary, bonuses and incentives, less deductions',
                style: TextStyle(color: c.muted, fontSize: 13),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        MoneyTile(
          key: const Key('tile-pending'),
          label: 'Pending',
          value: money(s.pending),
          valueColor: owing ? c.deal : null,
          big: true,
          caption: owing
              ? 'You owe Deligro this — it comes off your next payout'
              : 'Earned and waiting for your next payout',
          captionColor: owing ? c.deal : null,
        ),
        const SizedBox(height: 12),
        MoneyTile(
          key: const Key('tile-paid'),
          label: 'Paid out',
          value: money(s.paid),
        ),
        const SizedBox(height: 12),
        // Riders are on a fixed salary: there is no pay per delivery to show.
        Panel(
          key: const Key('tile-average'),
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Earnings per delivery',
                style: TextStyle(
                  color: c.muted,
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 4),
              const Text(
                'Salaried — not paid per delivery',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w800,
                  height: 1.25,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        MoneyTile(
          key: const Key('tile-last-payout'),
          label: 'Last payout',
          value: last == null ? 'No payout yet' : money(last.amount),
          caption: last == null
              ? null
              : [
                  formatDay(last.paidOn),
                  if (last.reference != null) 'Ref ${last.reference}',
                ].join(' · '),
        ),
        const SizedBox(height: 12),
        _Pair(
          MoneyTile(
            key: const Key('tile-incentives'),
            label: 'Incentives',
            value: money(s.incentives),
          ),
          MoneyTile(
            key: const Key('tile-bonuses'),
            label: 'Bonuses',
            value: money(s.bonuses),
          ),
        ),
        const SizedBox(height: 12),
        _Pair(
          MoneyTile(
            key: const Key('tile-adjustments'),
            label: 'Adjustments',
            value: money(s.adjustments),
          ),
          MoneyTile(
            key: const Key('tile-deductions'),
            label: 'Deductions',
            value: s.deductions == 0 ? money(0) : money(-s.deductions),
          ),
        ),
        const SizedBox(height: 12),
        _Pair(
          MoneyTile(
            key: const Key('tile-salary'),
            label: 'Salary',
            value: money(s.salary),
          ),
          null,
        ),
        const RowsLabel('Details'),
        RowsCard(
          children: [
            NavRow(
              key: const Key('row-records'),
              icon: Icons.receipt_long_outlined,
              title: 'Records',
              subtitle: 'Salary, bonuses, incentives and deductions',
              onTap: () => context.push('$earningsPath/records'),
            ),
            NavRow(
              key: const Key('row-payouts'),
              icon: Icons.account_balance_outlined,
              title: 'Payouts',
              subtitle: 'What has been paid to you',
              onTap: () => context.push('$earningsPath/payouts'),
            ),
            NavRow(
              key: const Key('row-incentives'),
              icon: Icons.emoji_events_outlined,
              title: 'Incentives & targets',
              subtitle: 'Your progress towards bonuses',
              onTap: () => context.push('$earningsPath/incentives'),
            ),
            NavRow(
              key: const Key('row-statement'),
              icon: Icons.picture_as_pdf_outlined,
              title: 'Statement',
              subtitle: 'Pick dates, save a PDF or share a CSV',
              onTap: () => context.push('$earningsPath/statement'),
            ),
          ],
        ),
      ],
    );
  }
}

/// Two tiles side by side (built alike, so as tall as each other).
class _Pair extends StatelessWidget {
  const _Pair(this.left, this.right);

  final Widget left;
  final Widget? right;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(child: left),
      const SizedBox(width: 12),
      Expanded(child: right ?? const SizedBox.shrink()),
    ],
  );
}

/// Today · Week · Month · Total.
class _PeriodSwitch extends StatelessWidget {
  const _PeriodSwitch({required this.period, required this.onChanged});

  final _Period period;
  final ValueChanged<_Period> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: c.surface2,
        borderRadius: BorderRadius.circular(radiusBlock),
      ),
      child: Row(
        children: [
          for (final p in _Period.values)
            Expanded(
              child: Semantics(
                button: true,
                selected: p == period,
                label: p.heading,
                child: InkWell(
                  key: Key('period-${p.name}'),
                  borderRadius: BorderRadius.circular(radiusBlock - 4),
                  onTap: () => onChanged(p),
                  child: Container(
                    constraints: const BoxConstraints(minHeight: 44),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: p == period ? c.surface : Colors.transparent,
                      borderRadius: BorderRadius.circular(radiusBlock - 4),
                      border: p == period ? Border.all(color: c.line) : null,
                    ),
                    child: ExcludeSemantics(
                      child: Text(
                        p.tab,
                        style: TextStyle(
                          fontWeight: FontWeight.w800,
                          fontSize: 14,
                          color: p == period ? c.ink : c.muted,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
