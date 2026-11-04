import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../data/wallet_change_repository.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';

/// One id per sheet: a lost answer retried is the same action, not a second one.
String _newActionId() {
  final r = Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

/// "No change? Add to wallet", at the door of a cash delivery. The rider types what they
/// received and the customer's code. The server works out the change and records the
/// cash as the full amount, so the rider hands over all of it. Answers with what was
/// added, or null if the rider closed it.
Future<WalletChangeResult?> showWalletChangeSheet(
  BuildContext context, {
  required String orderId,
  required int cashDue,
  required int maxPerOrder,
}) =>
    showModalBottomSheet<WalletChangeResult>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => WalletChangeSheet(orderId: orderId, cashDue: cashDue, maxPerOrder: maxPerOrder),
    );

class WalletChangeSheet extends ConsumerStatefulWidget {
  const WalletChangeSheet({super.key, required this.orderId, required this.cashDue, required this.maxPerOrder});

  final String orderId;
  final int cashDue;
  final int maxPerOrder;

  @override
  ConsumerState<WalletChangeSheet> createState() => _WalletChangeSheetState();
}

class _WalletChangeSheetState extends ConsumerState<WalletChangeSheet> {
  final _received = TextEditingController();
  final _code = TextEditingController();
  final _actionId = _newActionId();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _received.dispose();
    _code.dispose();
    super.dispose();
  }

  int get _amount => int.tryParse(_received.text) ?? 0;
  int get _change => _amount - widget.cashDue;

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final result = await ref
        .read(walletChangeRepoProvider)
        .add(widget.orderId, received: _amount, code: _code.text.trim(), actionId: _actionId);
    if (!mounted) return;
    if (result.ok) {
      Navigator.of(context).pop(result);
      return;
    }
    setState(() {
      _busy = false;
      _error = result.error;
      _code.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final change = _change;
    final overLimit = change > widget.maxPerOrder;
    final ready = !_busy && change > 0 && !overLimit && _code.text.trim().length == 6;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 16, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Add the change to the wallet', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
          const SizedBox(height: 4),
          Text('Collect ${rupees(widget.cashDue)}. You hand over all the cash you received.',
              style: TextStyle(color: c.muted, fontSize: 14)),
          const SizedBox(height: 14),
          TextField(
            key: const Key('wallet-received'),
            controller: _received,
            autofocus: true,
            enabled: !_busy,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            decoration: const InputDecoration(labelText: 'Cash received'),
            onChanged: (_) => setState(() {}),
          ),
          if (change > 0) ...[
            const SizedBox(height: 8),
            Text(
              overLimit
                  ? 'That is ${rupees(change)}, more than the ${rupees(widget.maxPerOrder)} you can add. Give the change in cash.'
                  : '${rupees(change)} goes to the customer\'s wallet.',
              key: const Key('wallet-change-preview'),
              style: TextStyle(fontWeight: FontWeight.w700, color: overLimit ? c.deal : c.ink),
            ),
          ],
          const SizedBox(height: 12),
          TextField(
            key: const Key('wallet-code'),
            controller: _code,
            enabled: !_busy,
            keyboardType: TextInputType.number,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
            decoration: const InputDecoration(labelText: 'Customer\'s code'),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 4),
          Text('The customer sees this code on their order screen.', style: TextStyle(color: c.muted, fontSize: 13)),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, key: const Key('wallet-error'), style: TextStyle(color: c.deal, fontWeight: FontWeight.w700)),
          ],
          const SizedBox(height: 14),
          FilledButton(
            key: const Key('wallet-add'),
            onPressed: ready ? _submit : null,
            child: Text(_busy ? 'Adding…' : 'Add to wallet'),
          ),
          TextButton(
            onPressed: _busy ? null : () => Navigator.of(context).pop(),
            child: const Text('Close, give cash instead'),
          ),
        ],
      ),
    );
  }
}
