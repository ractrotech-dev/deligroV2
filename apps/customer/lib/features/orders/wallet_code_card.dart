import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// During a cash delivery: if the rider has no change, the customer reads out this code
/// and the leftover goes to their wallet as points. The code exists only in the server's
/// answer, so it lives in this widget's state; asking again makes a new one.
class WalletCodeCard extends ConsumerStatefulWidget {
  const WalletCodeCard({super.key, required this.orderId});
  final String orderId;

  @override
  ConsumerState<WalletCodeCard> createState() => _WalletCodeCardState();
}

class _WalletCodeCardState extends ConsumerState<WalletCodeCard> {
  String? _code;
  String? _error;
  bool _busy = false;

  Future<void> _get() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final code = await ref.read(walletRepoProvider).changeCode(widget.orderId);
      if (mounted) setState(() => _code = code);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _code = null;
          _error = e.friendly;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _error = 'Couldn\'t get a code. Check your internet and try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final code = _code;
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.savings_outlined, size: 20, color: c.green),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Rider has no change?', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 2),
                    Text(
                      'Tell the rider this code. Your change goes to your wallet as points, to use on your next order.',
                      style: TextStyle(color: c.muted, fontSize: 13, height: 1.35),
                    ),
                  ],
                ),
              ),
            ],
          ),
          if (code != null) ...[
            const SizedBox(height: 12),
            Text(
              code,
              key: const Key('wallet-code'),
              textAlign: TextAlign.center,
              style: dataStyle(context, size: 30, weight: FontWeight.w800).copyWith(letterSpacing: 6),
            ),
            const SizedBox(height: 4),
            Text('Works for 10 minutes.', textAlign: TextAlign.center, style: TextStyle(color: c.muted, fontSize: 12.5)),
          ],
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: TextStyle(color: c.deal, fontSize: 13, fontWeight: FontWeight.w600)),
          ],
          const SizedBox(height: 10),
          OutlinedButton(
            key: const Key('wallet-get-code'),
            onPressed: _busy ? null : _get,
            child: Text(code == null ? 'Get code' : 'Get a new code'),
          ),
        ],
      ),
    );
  }
}
