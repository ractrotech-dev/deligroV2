import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/format.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// "Use my wallet" at checkout. The customer picks any whole amount up to their balance
/// and the bill. A preview: the server takes the points under a lock when the order is
/// placed, so a stale balance costs a clear message, never a wrong charge.
class WalletChoice extends StatelessWidget {
  const WalletChoice({
    super.key,
    required this.balance,
    required this.max,
    required this.use,
    required this.controller,
    required this.cashDue,
    required this.online,
    required this.enabled,
    required this.onUse,
    required this.onAmount,
  });

  final int balance;

  /// The most they can use on this bill.
  final int max;
  final bool use;
  final TextEditingController controller;

  /// What is left for the rider to collect.
  final int cashDue;

  /// Paying online: points don't combine with the gateway yet.
  final bool online;
  final bool enabled;
  final ValueChanged<bool> onUse;
  final VoidCallback onAmount;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final on = use && !online;
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(Icons.savings_outlined, size: 20, color: c.green),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Use my wallet', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                    Text('You have $balance points (1 point = ₹1)', style: TextStyle(color: c.muted, fontSize: 13)),
                  ],
                ),
              ),
              Switch(
                key: const Key('wallet-use'),
                value: on,
                onChanged: online || !enabled ? null : onUse,
              ),
            ],
          ),
          if (online)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('Points can only be used on cash orders for now.', style: TextStyle(color: c.muted, fontSize: 12.5)),
            ),
          if (on) ...[
            const Divider(height: 20),
            Row(
              children: [
                const Expanded(child: Text('Points to use', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600))),
                SizedBox(
                  width: 96,
                  child: TextField(
                    key: const Key('wallet-points'),
                    controller: controller,
                    enabled: enabled,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(7)],
                    textAlign: TextAlign.right,
                    decoration: const InputDecoration(isDense: true),
                    onChanged: (_) => onAmount(),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text('You can use up to $max on this order.', style: TextStyle(color: c.muted, fontSize: 12.5)),
            const SizedBox(height: 6),
            Text(
              cashDue > 0 ? 'Pay the rider ${rupees(cashDue)} in cash.' : 'Your points cover this order. Nothing to pay the rider.',
              key: const Key('wallet-cash-due'),
              style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
            ),
          ],
        ],
      ),
    );
  }
}
