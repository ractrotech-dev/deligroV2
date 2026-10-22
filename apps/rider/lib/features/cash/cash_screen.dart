import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/money.dart';
import '../../models/cash.dart';
import '../../state/cash.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../widgets/rows.dart';
import '../earnings/earnings_widgets.dart' show StatusChip;
import 'cash_errors.dart';
import 'collections_screen.dart';
import 'deposit_sheet.dart';
import 'dispute_sheet.dart';

/// Where the Cash screen lives: under More.
const cashPath = '/more/cash';

/// `/more/cash` and the order-wise list under it. Added to the More route.
final cashRoute = GoRoute(
  path: 'cash',
  builder: (_, _) => const CashScreen(),
  routes: [
    GoRoute(path: 'collections', builder: (_, _) => const CollectionsScreen()),
  ],
);

final _timeFmt = DateFormat('d MMM, h:mm a');

String _istTime(DateTime at) =>
    _timeFmt.format(at.toUtc().add(const Duration(hours: 5, minutes: 30)));

/// The rider's cash: what to collect, what is collected, what is deposited
/// and what is still in their hand; the deposit sheet; day-by-day
/// reconciliation with a dispute button; the deposits and their status.
///
/// Cash collected for Deligro is not the rider's earnings, and this screen
/// says so; none of it is ever added to the Earnings tab.
class CashScreen extends ConsumerStatefulWidget {
  const CashScreen({super.key});

  @override
  ConsumerState<CashScreen> createState() => _CashScreenState();
}

class _CashScreenState extends ConsumerState<CashScreen> {
  @override
  void initState() {
    super.initState();
    // The summary is shared with More and Home and stays loaded there, so
    // opening the screen asks again for the current figures.
    Future.microtask(() {
      if (mounted) refreshCash(ref);
    });
  }

  @override
  Widget build(BuildContext context) {
    final summary = ref.watch(cashSummaryProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Cash')),
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {
            refreshCash(ref);
            await ref
                .read(cashSummaryProvider.future)
                .then<void>((_) {}, onError: (_) {});
          },
          child: AsyncBody<CashSummary>(
            value: summary,
            onRetry: () => refreshCash(ref),
            builder: (s) => _CashBody(summary: s),
          ),
        ),
      ),
    );
  }
}

class _CashBody extends ConsumerWidget {
  const _CashBody({required this.summary});

  final CashSummary summary;

  Future<void> _deposit(BuildContext context, WidgetRef ref) async {
    final sent = await showDepositSheet(
      context,
      available: summary.available,
    );
    if (sent == true) {
      refreshCash(ref);
      if (context.mounted) {
        showSnack(context, 'Sent. A manager will confirm your deposit.');
      }
    }
  }

  Future<void> _dispute(BuildContext context, WidgetRef ref, String day) async {
    final sent = await showDisputeSheet(context, day: day);
    if (sent == true) {
      refreshCash(ref);
      if (context.mounted) {
        showSnack(context, 'Report sent. A manager will check it.');
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final s = summary;
    final deposits = ref.watch(cashDepositsProvider);
    final disputes = ref.watch(cashDisputesProvider).value ?? const [];
    final openDays = {
      for (final d in disputes)
        if (d.open) d.day,
    };
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(2, 0, 2, 12),
          child: Text(
            'Cash you collect belongs to Deligro. It is not part of your earnings.',
            key: const Key('cash-not-earnings'),
            style: TextStyle(color: c.muted, fontSize: 14, height: 1.35),
          ),
        ),
        _PendingCard(
          summary: s,
          onDeposit: () => _deposit(context, ref),
        ),
        const SizedBox(height: 12),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: _Tile(
                key: const Key('tile-to-collect'),
                label: 'To collect now',
                value: money(s.toCollect),
                caption: 'On your current orders',
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _Tile(
                key: const Key('tile-collected-today'),
                label: 'Collected today',
                value: money(s.collectedToday),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: _Tile(
                key: const Key('tile-deposited-today'),
                label: 'Deposited today',
                value: money(s.depositedToday),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _Tile(
                key: const Key('tile-awaiting'),
                label: 'Awaiting confirmation',
                value: money(s.submittedAwaiting),
                caption: 'Sent, not yet confirmed',
              ),
            ),
          ],
        ),
        if (s.neverCollected)
          const Padding(
            padding: EdgeInsets.only(top: 12),
            child: Panel(
              key: Key('cash-empty'),
              child: EmptyState(
                icon: Icons.payments_outlined,
                title: 'No cash collected yet',
                body:
                    'When a customer pays you in cash, it shows up here and you can deposit it with a manager.',
              ),
            ),
          )
        else ...[
          const SectionTitle(
            'Day by day',
            padding: EdgeInsets.fromLTRB(2, 24, 2, 10),
          ),
          for (final d in s.days) ...[
            _DayCard(
              day: d,
              reported: openDays.contains(d.day),
              onDispute: () => _dispute(context, ref, d.day),
            ),
            const SizedBox(height: 10),
          ],
        ],
        const SizedBox(height: 8),
        RowsCard(
          children: [
            NavRow(
              key: const Key('row-collections'),
              icon: Icons.receipt_long_outlined,
              title: 'Order-wise collections',
              subtitle: 'Cash collected and orders paid online',
              onTap: () => context.push('$cashPath/collections'),
            ),
          ],
        ),
        const SectionTitle(
          'Your deposits',
          padding: EdgeInsets.fromLTRB(2, 24, 2, 10),
        ),
        deposits.when(
          skipLoadingOnRefresh: true,
          data: (list) => list.isEmpty
              ? Text(
                  'No deposits yet.',
                  key: const Key('deposits-empty'),
                  style: TextStyle(color: c.muted),
                )
              : Column(
                  children: [
                    for (final d in list) ...[
                      _DepositCard(key: ValueKey(d.id), deposit: d),
                      const SizedBox(height: 10),
                    ],
                  ],
                ),
          loading: () => const Padding(
            padding: EdgeInsets.all(24),
            child: Center(child: CircularProgressIndicator()),
          ),
          error: (e, _) => ErrorRetry(
            error: e,
            onRetry: () => ref.invalidate(cashDepositsProvider),
          ),
        ),
        if (disputes.isNotEmpty) ...[
          const SectionTitle(
            'Your reports',
            padding: EdgeInsets.fromLTRB(2, 24, 2, 10),
          ),
          for (final d in disputes) ...[
            _DisputeCard(dispute: d),
            const SizedBox(height: 10),
          ],
        ],
      ],
    );
  }
}

/// The large pending figure: red, with the reason, when it is over the limit
/// or has been held too long.
class _PendingCard extends StatelessWidget {
  const _PendingCard({required this.summary, required this.onDeposit});

  final CashSummary summary;
  final VoidCallback onDeposit;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = summary;
    final reasons = [
      if (s.overLimit) 'More than the ${money(s.limit)} limit.',
      if (s.overHours)
        'Some of it has been with you for over ${s.maxHours} hours.',
    ];
    final tone = s.over ? c.deal : c.ink;
    return Container(
      key: const Key('cash-pending'),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: s.over ? c.dealSoft : c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: s.over ? c.deal : c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Pending deposit',
            style: TextStyle(
              color: c.muted,
              fontSize: 14,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              money(s.pending),
              key: const Key('cash-pending-amount'),
              style: dataStyle(
                context,
                size: 40,
                weight: FontWeight.w800,
              ).copyWith(color: tone),
            ),
          ),
          const SizedBox(height: 2),
          Text(
            'Cash in your hand to hand over to a manager',
            style: TextStyle(color: c.muted, fontSize: 13, height: 1.3),
          ),
          for (final r in reasons)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Row(
                key: const Key('cash-over-reason'),
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.warning_amber_rounded, size: 18, color: c.deal),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      r,
                      style: TextStyle(
                        color: c.deal,
                        fontWeight: FontWeight.w700,
                        fontSize: 14,
                        height: 1.3,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (s.submittedAwaiting > 0)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                '${money(s.submittedAwaiting)} sent and waiting for a manager.',
                key: const Key('cash-awaiting-note'),
                style: TextStyle(color: c.muted, fontSize: 14, height: 1.3),
              ),
            ),
          const SizedBox(height: 14),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              key: const Key('deposit-cash'),
              onPressed: s.available > 0 ? onDeposit : null,
              icon: const Icon(Icons.account_balance_wallet_outlined),
              label: const Text('Deposit cash'),
            ),
          ),
        ],
      ),
    );
  }
}

/// A labelled figure that shrinks rather than overflows at large text sizes.
class _Tile extends StatelessWidget {
  const _Tile({super.key, required this.label, required this.value, this.caption});

  final String label;
  final String value;
  final String? caption;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Panel(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            label,
            style: TextStyle(
              color: c.muted,
              fontSize: 13,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              style: dataStyle(context, size: 21, weight: FontWeight.w800),
            ),
          ),
          if (caption != null) ...[
            const SizedBox(height: 4),
            Text(
              caption!,
              style: TextStyle(color: c.muted, fontSize: 12.5, height: 1.3),
            ),
          ],
        ],
      ),
    );
  }
}

StatusChip _dayChip(BuildContext context, DayStatus status) {
  final c = context.colors;
  return switch (status) {
    DayStatus.settled => StatusChip('Settled', fg: c.green, bg: c.greenSoft),
    DayStatus.pending => StatusChip(
      'Pending',
      fg: c.accentInk,
      bg: c.accentSoft,
    ),
    DayStatus.disputed => StatusChip('Disputed', fg: c.deal, bg: c.dealSoft),
  };
}

class _DayCard extends StatelessWidget {
  const _DayCard({
    required this.day,
    required this.reported,
    required this.onDispute,
  });

  final CashDay day;

  /// A report for this day is already with the managers.
  final bool reported;
  final VoidCallback onDispute;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = day;
    return Panel(
      key: Key('cash-day-${d.day}'),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  formatDay(d.day),
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              _dayChip(context, d.status),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'Collected ${money(d.collected)} · Deposited ${money(d.deposited)}',
            style: TextStyle(color: c.muted, fontSize: 14, height: 1.3),
          ),
          if (d.note != null)
            Container(
              key: Key('cash-day-note-${d.day}'),
              margin: const EdgeInsets.only(top: 10),
              padding: const EdgeInsets.all(10),
              width: double.infinity,
              decoration: BoxDecoration(
                color: c.dealSoft,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                "Manager's note: ${d.note}",
                style: TextStyle(
                  color: c.deal,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  height: 1.3,
                ),
              ),
            ),
          const SizedBox(height: 4),
          Align(
            alignment: Alignment.centerLeft,
            child: reported
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    child: Text(
                      'Problem reported. A manager will check it.',
                      key: Key('reported-${d.day}'),
                      style: TextStyle(color: c.muted, fontSize: 13),
                    ),
                  )
                : TextButton.icon(
                    key: Key('dispute-${d.day}'),
                    onPressed: onDispute,
                    icon: const Icon(Icons.flag_outlined, size: 18),
                    label: const Text('Report a problem'),
                  ),
          ),
        ],
      ),
    );
  }
}

class _DepositCard extends ConsumerStatefulWidget {
  const _DepositCard({super.key, required this.deposit});

  final CashDeposit deposit;

  @override
  ConsumerState<_DepositCard> createState() => _DepositCardState();
}

class _DepositCardState extends ConsumerState<_DepositCard> {
  bool _busy = false;

  Future<void> _withdraw() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Withdraw this deposit?'),
        content: Text(
          '${money(widget.deposit.amount)} goes back to your pending cash.',
        ),
        actions: [
          TextButton(
            key: const Key('withdraw-keep'),
            onPressed: () => Navigator.pop(dialog, false),
            child: const Text('Keep it'),
          ),
          TextButton(
            key: const Key('withdraw-confirm'),
            onPressed: () => Navigator.pop(dialog, true),
            child: const Text('Withdraw'),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    setState(() => _busy = true);
    try {
      await ref.read(cashRepoProvider).withdrawDeposit(widget.deposit.id);
      refreshCash(ref);
    } catch (e) {
      if (mounted) showSnack(context, cashErrorText(e));
      // Another answer may have landed meanwhile (a manager decided).
      refreshCash(ref);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = widget.deposit;
    final chip = switch (d.status) {
      DepositStatus.submitted => StatusChip(
        d.status.label,
        fg: c.accentInk,
        bg: c.accentSoft,
      ),
      DepositStatus.confirmed => StatusChip(
        d.status.label,
        fg: c.green,
        bg: c.greenSoft,
      ),
      DepositStatus.disputed => StatusChip(
        d.status.label,
        fg: c.deal,
        bg: c.dealSoft,
      ),
      DepositStatus.withdrawn || DepositStatus.unknown => StatusChip(
        d.status.label,
        fg: c.muted,
        bg: c.surface2,
      ),
    };
    final muted = TextStyle(color: c.muted, fontSize: 14, height: 1.35);
    return Panel(
      key: Key('deposit-${d.id}'),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  money(d.amount),
                  style: dataStyle(context, size: 22, weight: FontWeight.w800),
                ),
              ),
              chip,
            ],
          ),
          const SizedBox(height: 4),
          Text(
            [
              d.methodLabel,
              if (d.managerName != null) d.managerName!,
              _istTime(d.createdAt),
            ].join(' · '),
            style: muted,
          ),
          if (d.reference != null) Text('Reference ${d.reference}', style: muted),
          if (d.hasReceipt) Text('Receipt photo attached', style: muted),
          if (d.note != null) Text('Your note: ${d.note}', style: muted),
          if (d.decisionNote != null)
            Container(
              key: Key('deposit-note-${d.id}'),
              margin: const EdgeInsets.only(top: 10),
              padding: const EdgeInsets.all(10),
              width: double.infinity,
              decoration: BoxDecoration(
                color: c.dealSoft,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Text(
                "Manager's note: ${d.decisionNote}",
                style: TextStyle(
                  color: c.deal,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  height: 1.3,
                ),
              ),
            ),
          if (d.status == DepositStatus.submitted)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: Key('withdraw-${d.id}'),
                onPressed: _busy ? null : _withdraw,
                icon: const Icon(Icons.undo_rounded, size: 18),
                label: const Text('Withdraw'),
              ),
            ),
        ],
      ),
    );
  }
}

class _DisputeCard extends StatelessWidget {
  const _DisputeCard({required this.dispute});

  final CashDispute dispute;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final d = dispute;
    final muted = TextStyle(color: c.muted, fontSize: 14, height: 1.35);
    return Panel(
      key: Key('dispute-card-${d.id}'),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  formatDay(d.day),
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              d.open
                  ? StatusChip('With a manager', fg: c.accentInk, bg: c.accentSoft)
                  : StatusChip('Resolved', fg: c.green, bg: c.greenSoft),
            ],
          ),
          const SizedBox(height: 4),
          Text(d.message, style: muted),
          if (d.claimedAmount != null)
            Text('You said it should be ${money(d.claimedAmount!)}', style: muted),
          if (d.resolution != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                'Answer: ${d.resolution}',
                style: TextStyle(
                  color: c.ink,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  height: 1.35,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
