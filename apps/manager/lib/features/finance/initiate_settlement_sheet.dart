import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/finance.dart';
import '../../models/outcome.dart';
import '../../models/payment_request.dart';
import '../../models/rider.dart' show ymd;
import '../../models/settlement.dart';
import '../../state/finance.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';

/// "Put up for payment": builds a settlement draft for a shop and asks a
/// different person to approve it (§7 permission rule, maker–checker).
Future<void> showInitiateSettlementSheet(BuildContext context, {required VendorDue due}) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: _InitiateSheet(due: due),
      ),
    );

/// What a refusal of an initiation means, in words.
String initiateRefusalText(Refused<Object?> r) => switch (r.code) {
      'nothing_to_pay' => 'There is nothing to pay for that period.',
      'negative_net' => 'This shop owes Deligro ${rupees(((r.extra['netPayable'] as num?) ?? 0).abs())} — collect it separately',
      'duplicate_pending' => 'This shop already has a settlement waiting for approval.',
      'already_settled' => 'That order is already in a settlement.',
      'permission_denied' || 'forbidden' => "You don't have permission to put payments up. Ask an admin.",
      'not_found' => "That isn't in your zones.",
      'rate_limited' => 'Too many changes at once. Wait a moment and try again.',
      _ => "That didn't go through (${r.code}).",
    };

class _InitiateSheet extends ConsumerStatefulWidget {
  const _InitiateSheet({required this.due});
  final VendorDue due;

  @override
  ConsumerState<_InitiateSheet> createState() => _InitiateSheetState();
}

class _InitiateSheetState extends ConsumerState<_InitiateSheet> {
  late DateTime _from;
  late DateTime _to;
  bool _singleOrder = false;
  final _orderId = TextEditingController();
  final _note = TextEditingController();
  PayMethod _method = PayMethod.bank;
  bool _busy = false;
  String? _error;
  SettlementInitiation? _pending;
  SettlementInitiated? _done;

  @override
  void initState() {
    super.initState();
    final today = istToday();
    final oldest = widget.due.oldestUnsettledAt?.toUtc().add(const Duration(hours: 5, minutes: 30));
    _from = oldest == null ? today.subtract(const Duration(days: 6)) : DateTime(oldest.year, oldest.month, oldest.day);
    final span = widget.due.cycle == 'monthly' ? 30 : 6;
    final end = _from.add(Duration(days: span));
    _to = end.isAfter(today) ? today : end;
  }

  @override
  void dispose() {
    _orderId.dispose();
    _note.dispose();
    super.dispose();
  }

  SettlementInitiation _draft() => SettlementInitiation(
        vendorId: widget.due.vendor.id,
        from: _singleOrder ? null : _from,
        to: _singleOrder ? null : _to,
        orderId: _singleOrder ? _orderId.text.trim() : null,
        method: _method,
        note: _note.text,
      );

  /// Sends [d]; a fault keeps it so Retry re-sends the same id.
  Future<void> _send(SettlementInitiation d) async {
    setState(() {
      _busy = true;
      _error = null;
      _pending = d;
    });
    try {
      final out = await ref.read(financeRepoProvider).initiateSettlement(d);
      if (!mounted) return;
      switch (out) {
        case Applied(:final value):
          setState(() {
            _done = value;
            _pending = null;
          });
          ref.invalidate(vendorDuesProvider);
          ref.invalidate(settlementsProvider);
        case Refused():
          setState(() {
            _error = initiateRefusalText(out);
            _pending = null;
          });
      }
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (mounted) setState(() => _error = '${e.friendly} Tap Retry to send the same request again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pick(bool from) async {
    final today = istToday();
    final d = await showDatePicker(
      context: context,
      initialDate: from ? _from : _to,
      firstDate: DateTime(today.year - 1),
      lastDate: today,
    );
    if (d == null) return;
    setState(() {
      if (from) {
        _from = d;
        if (_to.isBefore(d)) _to = d;
      } else {
        _to = d;
        if (_from.isAfter(d)) _from = d;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final due = widget.due;
    final done = _done;
    if (done != null) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Put up for payment', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: c.ink)),
          const SizedBox(height: 10),
          Text(rupeesSigned(done.settlement.netPayable), style: dataStyle(context, size: 26, weight: FontWeight.w800)),
          Text('${due.vendor.name} · ${count(done.settlement.orders)} orders', style: TextStyle(color: c.muted)),
          const SizedBox(height: 10),
          Text('Waiting for approval by someone else. Nothing is paid until they approve it with the bank reference.',
              style: TextStyle(color: c.amberText, fontWeight: FontWeight.w600)),
          const SizedBox(height: 14),
          FilledButton(onPressed: () => Navigator.pop(context), child: const Text('Done')),
        ]),
      );
    }
    final orderOk = !_singleOrder || _orderId.text.trim().length >= 6;
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Put ${due.vendor.name} up for payment',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: c.ink)),
        Text('${rupees(due.payable)} due now · a different person approves it', style: TextStyle(color: c.muted)),
        const SizedBox(height: 12),
        SegmentedButton<bool>(
          segments: const [
            ButtonSegment(value: false, label: Text('A period')),
            ButtonSegment(value: true, label: Text('One order')),
          ],
          selected: {_singleOrder},
          onSelectionChanged: (s) => setState(() => _singleOrder = s.first),
        ),
        const SizedBox(height: 10),
        if (!_singleOrder)
          Row(children: [
            Expanded(
              child: OutlinedButton(
                key: const Key('initiate-from'),
                onPressed: () => _pick(true),
                child: Text('From ${ymd(_from)}'),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: OutlinedButton(
                key: const Key('initiate-to'),
                onPressed: () => _pick(false),
                child: Text('To ${ymd(_to)}'),
              ),
            ),
          ])
        else
          TextField(
            key: const Key('initiate-order-id'),
            controller: _orderId,
            decoration: const InputDecoration(labelText: 'Order ID (from the order screen)'),
            onChanged: (_) => setState(() {}),
          ),
        const SizedBox(height: 10),
        DropdownButtonFormField<PayMethod>(
          initialValue: _method,
          decoration: const InputDecoration(labelText: 'How it will be paid'),
          items: [for (final m in PayMethod.choices) DropdownMenuItem(value: m, child: Text(m.label))],
          onChanged: (m) => setState(() => _method = m ?? _method),
        ),
        const SizedBox(height: 8),
        TextField(controller: _note, decoration: const InputDecoration(labelText: 'Note (optional)')),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Text(_error!, style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
          ),
        const SizedBox(height: 14),
        Row(children: [
          if (_pending != null && _error != null && !_busy)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: OutlinedButton(onPressed: () => _send(_pending!), child: const Text('Retry')),
            ),
          Expanded(
            child: FilledButton(
              key: const Key('initiate-submit'),
              onPressed: _busy || !orderOk ? null : () => _send(_draft()),
              child: Text(_busy ? 'Sending…' : 'Ask for approval'),
            ),
          ),
        ]),
      ]),
    );
  }
}
