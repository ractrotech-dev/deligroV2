import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/finance.dart';
import '../../state/finance.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import 'finance_overview.dart';

/// The Finance tab (§7): every sales, commission and payment figure for the
/// chosen period and zone, and the way into each list behind them.
class FinanceScreen extends ConsumerWidget {
  const FinanceScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final q = ref.watch(financeQueryProvider);
    final value = ref.watch(financeOverviewProvider(q));
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Finance'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(financeOverviewProvider(q).future),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            const FinancePeriodChips(),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
              child: Text(
                q.from == q.to ? q.from : '${q.from} to ${q.to} (India time)',
                style: TextStyle(fontSize: 12, color: c.muted),
              ),
            ),
            _body(context, ref, value),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, WidgetRef ref, AsyncValue<FinanceOverview> value) {
    final err = value.error;
    if (!value.hasValue && err is ApiException && (err.code == 'permission_denied' || err.status == 403)) {
      return const _FinanceOff();
    }
    if (!value.hasValue && err is ApiException && err.unauthorized) {
      Future.microtask(() => handleUnauthorized(ref, err));
    }
    if (!value.hasValue && err != null) {
      return ErrorRetry(error: err, onRetry: () => ref.invalidate(financeOverviewProvider));
    }
    if (!value.hasValue) {
      return const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator()));
    }
    final fq = ref.read(financeQueryProvider);
    final canReport = ref.watch(managerMeProvider).value?.can('manager.reports.view') ?? false;
    return FinanceOverviewBody(
      overview: value.requireValue,
      onExport: !canReport
          ? null
          : () => context.push(Uri(path: '/more/reports/finance-daily', queryParameters: {
        'from': fq.from,
        'to': fq.to,
        'zone': ?fq.zoneId,
      }).toString()),
    );
  }
}

class _FinanceOff extends StatelessWidget {
  const _FinanceOff();

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          children: [
            Icon(Icons.lock_outline, size: 36, color: context.colors.muted),
            const SizedBox(height: 10),
            const Text("Finance isn't switched on for your account", textAlign: TextAlign.center),
            const SizedBox(height: 4),
            Text('Ask an admin to turn on Finance in Feature access.',
                textAlign: TextAlign.center, style: TextStyle(color: context.colors.muted)),
          ],
        ),
      );
}

/// Today · 7 days · 30 days · This month · Custom. Custom picks an IST range
/// ending no later than today, at most 366 days.
class FinancePeriodChips extends ConsumerWidget {
  const FinancePeriodChips({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final r = ref.watch(financeRangeProvider);
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Row(
        children: [
          for (final p in FinancePeriod.values)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ChoiceChip(
                key: Key('finance-period-${p.name}'),
                label: Text(p.label),
                selected: r.period == p,
                onSelected: (_) async {
                  if (p != FinancePeriod.custom) {
                    ref.read(financeRangeProvider.notifier).set(p);
                    return;
                  }
                  final today = istToday();
                  final picked = await showDateRangePicker(
                    context: context,
                    firstDate: DateTime(today.year - 3),
                    lastDate: today,
                    initialDateRange: r.custom,
                  );
                  if (picked == null) return;
                  if (picked.end.difference(picked.start).inDays > 365) {
                    if (context.mounted) showSnack(context, 'Pick 366 days or fewer.');
                    return;
                  }
                  ref.read(financeRangeProvider.notifier).setCustom(picked);
                },
              ),
            ),
        ],
      ),
    );
  }
}
