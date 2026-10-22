import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/money.dart';
import '../../state/cash.dart';
import '../../theme/app_theme.dart';
import 'cash_errors.dart';

/// The longest message the server keeps.
const disputeMessageMax = 500;

/// "This day's figure is wrong." Sends the report to the managers. True when
/// it was sent.
Future<bool?> showDisputeSheet(BuildContext context, {required String day}) =>
    showModalBottomSheet<bool>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      builder: (_) => DisputeSheet(day: day),
    );

class DisputeSheet extends ConsumerStatefulWidget {
  const DisputeSheet({super.key, required this.day});

  final String day;

  @override
  ConsumerState<DisputeSheet> createState() => _DisputeSheetState();
}

class _DisputeSheetState extends ConsumerState<DisputeSheet> {
  final _message = TextEditingController();
  final _claimed = TextEditingController();
  bool _busy = false;
  String? _messageError;
  String? _error;

  @override
  void dispose() {
    _message.dispose();
    _claimed.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (_busy) return;
    final message = _message.text.trim();
    if (message.isEmpty) {
      setState(() => _messageError = 'Tell us what looks wrong.');
      return;
    }
    setState(() {
      _busy = true;
      _messageError = null;
      _error = null;
    });
    try {
      await ref
          .read(cashRepoProvider)
          .raiseDispute(
            day: widget.day,
            message: message,
            claimedAmount: int.tryParse(_claimed.text.trim()),
          );
      if (mounted) Navigator.pop(context, true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = cashErrorText(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.viewInsetsOf(context).bottom,
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Report a problem',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 4),
              Text(
                'The figures for ${formatDay(widget.day)} look wrong? '
                'A manager will check them.',
                key: const Key('dispute-day'),
                style: TextStyle(color: c.muted),
              ),
              const SizedBox(height: 16),
              TextField(
                key: const Key('dispute-message'),
                controller: _message,
                maxLength: disputeMessageMax,
                maxLines: 4,
                minLines: 3,
                textCapitalization: TextCapitalization.sentences,
                decoration: InputDecoration(
                  labelText: 'What looks wrong?',
                  errorText: _messageError,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                key: const Key('dispute-claimed'),
                controller: _claimed,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: const InputDecoration(
                  labelText: 'What you think it should be (optional)',
                  prefixText: '₹ ',
                ),
              ),
              if (_error != null)
                Padding(
                  key: const Key('dispute-error'),
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    _error!,
                    style: TextStyle(
                      color: c.deal,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      key: const Key('dispute-cancel'),
                      onPressed: _busy ? null : () => Navigator.pop(context),
                      child: const Text('Cancel'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    flex: 2,
                    child: FilledButton(
                      key: const Key('dispute-send'),
                      onPressed: _busy ? null : _send,
                      child: _busy
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(strokeWidth: 2.5),
                            )
                          : const Text('Send report'),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
