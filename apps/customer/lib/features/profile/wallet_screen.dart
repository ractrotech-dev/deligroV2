import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/wallet.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// The wallet: balance and every point added, used or corrected
/// (app/(customer)/profile/wallet). Points never expire and can't be taken out as cash.
class WalletScreen extends ConsumerStatefulWidget {
  const WalletScreen({super.key});

  @override
  ConsumerState<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends ConsumerState<WalletScreen> {
  /// Older pages, added as the customer asks for them.
  final _older = <WalletMove>[];
  String? _cursor;
  bool _cursorSet = false;
  bool _loadingMore = false;

  Future<void> _more(String cursor) async {
    setState(() => _loadingMore = true);
    try {
      final page = await ref.read(walletRepoProvider).wallet(cursor: cursor);
      if (!mounted) return;
      setState(() {
        _older.addAll(page.moves);
        _cursor = page.nextCursor;
        _cursorSet = true;
      });
    } catch (_) {
      // The button stays, so they can ask again.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(walletProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Wallet')),
      body: AsyncBody<WalletInfo>(
        value: async,
        onRetry: () => ref.invalidate(walletProvider),
        builder: (w) {
          final c = context.colors;
          final moves = [...w.moves, ..._older];
          final next = _cursorSet ? _cursor : w.nextCursor;
          return RefreshIndicator(
            onRefresh: () async {
              setState(() {
                _older.clear();
                _cursor = null;
                _cursorSet = false;
              });
              ref.invalidate(walletProvider);
              await ref.read(walletProvider.future);
            },
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(16),
              children: [
                Panel(
                  child: Column(
                    children: [
                      Text('Your points', style: TextStyle(color: c.muted, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 4),
                      Text('${w.balance}', key: const Key('wallet-balance'), style: dataStyle(context, size: 38, weight: FontWeight.w800)),
                      const SizedBox(height: 8),
                      Text(
                        '1 point = ₹1. Use them on any order at checkout. They never expire and can\'t be taken out as cash.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: c.muted, fontSize: 13, height: 1.4),
                      ),
                      if (!w.enabled) ...[
                        const SizedBox(height: 8),
                        Text('The wallet is switched off right now.',
                            style: TextStyle(color: c.deal, fontSize: 13, fontWeight: FontWeight.w600)),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 18),
                Text('History', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 6),
                if (moves.isEmpty)
                  Text('Nothing yet. When a rider adds your change, it shows here.', style: TextStyle(color: c.muted, fontSize: 14))
                else
                  for (final m in moves) _MoveRow(m),
                if (next != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: OutlinedButton(
                      onPressed: _loadingMore ? null : () => _more(next),
                      child: Text(_loadingMore ? 'Loading…' : 'Show older'),
                    ),
                  ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _MoveRow extends StatelessWidget {
  const _MoveRow(this.move);
  final WalletMove move;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final at = move.at;
    final sign = move.amount < 0 ? '−' : '+';
    return InkWell(
      onTap: move.orderId == null ? null : () => context.push('/orders/${move.orderId}'),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(move.label, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                  if (at != null)
                    Text(DateFormat('d MMM, h:mm a').format(at.toLocal()), style: TextStyle(color: c.muted, fontSize: 12.5)),
                  if (move.kind == 'admin_correction') Text(move.reason, style: TextStyle(color: c.muted, fontSize: 12.5)),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Text(
              '$sign${rupees(move.amount.abs())}',
              style: dataStyle(context, size: 15, weight: FontWeight.w800).copyWith(color: move.amount > 0 ? c.green : null),
            ),
          ],
        ),
      ),
    );
  }
}
