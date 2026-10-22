import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/money.dart';
import '../../models/earnings.dart';
import '../../state/earnings.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// Every payout made to the rider, newest first.
class PayoutsScreen extends ConsumerWidget {
  const PayoutsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final payouts = ref.watch(payoutsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Payouts')),
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(payoutsProvider);
            await ref
                .read(payoutsProvider.future)
                .then<void>((_) {}, onError: (_) {});
          },
          child: AsyncBody<List<Payout>>(
            value: payouts,
            onRetry: () => ref.invalidate(payoutsProvider),
            builder: (list) => list.isEmpty
                ? ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    children: [
                      ConstrainedBox(
                        constraints: const BoxConstraints(minHeight: 420),
                        child: const EmptyState(
                          icon: Icons.account_balance_outlined,
                          title: 'No payouts yet',
                          body: 'When Deligro pays you, it shows up here.',
                        ),
                      ),
                    ],
                  )
                : ListView.separated(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                    itemCount: list.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 12),
                    itemBuilder: (_, i) => _PayoutCard(payout: list[i]),
                  ),
          ),
        ),
      ),
    );
  }
}

class _PayoutCard extends StatelessWidget {
  const _PayoutCard({required this.payout});

  final Payout payout;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final p = payout;
    final muted = TextStyle(color: c.muted, fontSize: 14, height: 1.35);
    return Panel(
      key: Key('payout-${p.id}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            money(p.amount),
            style: dataStyle(context, size: 24, weight: FontWeight.w800),
          ),
          const SizedBox(height: 4),
          Text(
            '${p.methodLabel} · ${formatDay(p.paidOn)}',
            style: TextStyle(
              color: c.ink,
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
          if (p.reference != null) ...[
            const SizedBox(height: 2),
            Text('Reference ${p.reference}', style: muted),
          ],
          const SizedBox(height: 2),
          Text(
            '${p.items} ${p.items == 1 ? 'record' : 'records'} · up to ${formatDay(p.periodEnd)}',
            style: muted,
          ),
        ],
      ),
    );
  }
}
