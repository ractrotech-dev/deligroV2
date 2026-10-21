import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/outcome.dart';
import '../../models/payment_request.dart';
import '../../models/rider.dart';
import '../../state/providers.dart';
import '../../state/riders.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'payment_labels.dart';

/// Ask for a rider's salary payout (`manager.finance.initiate_payment`).
/// It goes to Approvals, where a different person approves it with the
/// payment reference — riders are salaried, so the salary is entered here
/// and added to anything already pending in their ledger.
Future<void> showPayoutRequestSheet(BuildContext context, WidgetRef ref, RiderDetail rider) async {
  final draft = await showModalBottomSheet<PayoutRequestDraft>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _PayoutSheet(rider: rider),
  );
  if (draft == null || !context.mounted) return;
  Future<void> send() async {
    try {
      final out = await ref.read(paymentsRepoProvider).request(draft);
      if (!context.mounted) return;
      switch (out) {
        case Applied():
          showSnack(context, 'Sent for approval. Someone else must approve it.');
          await ref.read(riderDetailProvider(rider.id).notifier).refresh();
        case Refused():
          showSnack(context, paymentRefusalText(out));
      }
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!context.mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(e.friendly), action: SnackBarAction(label: 'Retry', onPressed: send)));
    }
  }

  await send();
}

/// The last day of last month — the usual end of a salary period.
DateTime _lastMonthEnd(DateTime today) => DateTime(today.year, today.month, 0);

class _PayoutSheet extends StatefulWidget {
  const _PayoutSheet({required this.rider});
  final RiderDetail rider;

  @override
  State<_PayoutSheet> createState() => _PayoutSheetState();
}

class _PayoutSheetState extends State<_PayoutSheet> {
  late final TextEditingController _period;
  final _salary = TextEditingController();
  final _note = TextEditingController();
  PayMethod _method = PayMethod.bank;

  @override
  void initState() {
    super.initState();
    _period = TextEditingController(text: ymd(_lastMonthEnd(istToday())));
  }

  @override
  void dispose() {
    _period.dispose();
    _salary.dispose();
    _note.dispose();
    super.dispose();
  }

  DateTime? get _periodEnd {
    final t = _period.text.trim();
    if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(t)) return null;
    return DateTime.tryParse(t);
  }

  String? get _periodError {
    final p = _periodEnd;
    if (p == null) return 'Use the date format 2026-09-30.';
    if (p.isAfter(istToday())) return "The period can't end in the future.";
    return null;
  }

  double? get _salaryValue {
    final t = _salary.text.trim();
    if (t.isEmpty) return null;
    final v = double.tryParse(t);
    return v == null || v <= 0 ? -1 : v;
  }

  bool get _ok => _periodError == null && (_salaryValue ?? 0) >= 0;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final pending = widget.rider.money?.pending ?? 0;
    final salary = _salaryValue != null && _salaryValue! > 0 ? _salaryValue! : 0.0;
    final total = pending + salary;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, MediaQuery.viewInsetsOf(context).bottom + 20),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Salary payout for ${widget.rider.name}', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 6),
            Text('A different person approves it with the payment reference.',
                style: TextStyle(color: c.muted, fontSize: 13)),
            const SizedBox(height: 12),
            TextField(
              key: const Key('payout-period-end'),
              controller: _period,
              keyboardType: TextInputType.datetime,
              decoration: InputDecoration(
                labelText: 'Period ends on',
                errorText: _periodError,
                suffixIcon: IconButton(
                  icon: const Icon(Icons.calendar_month_outlined),
                  onPressed: () async {
                    final today = istToday();
                    final d = await showDatePicker(
                      context: context,
                      initialDate: _periodEnd != null && !_periodEnd!.isAfter(today) ? _periodEnd! : today,
                      firstDate: DateTime(today.year - 1),
                      lastDate: today,
                    );
                    if (d != null) setState(() => _period.text = ymd(d));
                  },
                ),
              ),
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<PayMethod>(
              key: const Key('payout-method'),
              initialValue: _method,
              decoration: const InputDecoration(labelText: 'Paid by'),
              items: [for (final m in PayMethod.choices) DropdownMenuItem(value: m, child: Text(m.label))],
              onChanged: (m) => setState(() => _method = m ?? _method),
            ),
            const SizedBox(height: 8),
            TextField(
              key: const Key('payout-salary'),
              controller: _salary,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'^\d*\.?\d{0,2}'))],
              decoration: InputDecoration(
                labelText: 'Salary for the period (₹, optional)',
                errorText: _salaryValue == -1 ? 'Enter an amount above zero.' : null,
              ),
              onChanged: (_) => setState(() {}),
            ),
            TextField(
              key: const Key('payout-note'),
              controller: _note,
              maxLength: 300,
              decoration: const InputDecoration(labelText: 'Note (optional)'),
            ),
            Text(
              'Will pay ${rupeesPaise(total)} (salary ${rupeesPaise(salary)} + ${rupeesPaise(pending)} pending in the ledger)',
              style: dataStyle(context, size: 13.5),
            ),
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                key: const Key('payout-submit'),
                onPressed: _ok
                    ? () => Navigator.pop(
                          context,
                          PayoutRequestDraft(
                            riderId: widget.rider.id,
                            periodEnd: _periodEnd!,
                            method: _method,
                            salaryAmount: salary > 0 ? salary : null,
                            note: _note.text,
                          ),
                        )
                    : null,
                child: const Text('Send for approval'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
