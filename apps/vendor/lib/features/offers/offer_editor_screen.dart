import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../models/growth.dart';
import '../../state/growth.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

/// Create or edit one of the shop's own promo codes. The code itself can't be
/// renamed once live (customers may already have it); the shop pays for it.
class OfferEditorScreen extends ConsumerStatefulWidget {
  const OfferEditorScreen({super.key, this.offer});

  final Offer? offer;

  @override
  ConsumerState<OfferEditorScreen> createState() => _OfferEditorScreenState();
}

class _OfferEditorScreenState extends ConsumerState<OfferEditorScreen> {
  final _form = GlobalKey<FormState>();
  Offer? get _o => widget.offer;
  late final _code = TextEditingController(text: _o?.code ?? '');
  late final _label = TextEditingController(text: _o?.label ?? '');
  late final _value = TextEditingController(text: _o == null ? '' : '${_o!.value}');
  late final _min = TextEditingController(text: _o == null || _o!.minOrder == 0 ? '' : '${_o!.minOrder}');
  late final _cap = TextEditingController(text: _o?.maxDiscount?.toString() ?? '');
  late final _perCustomer = TextEditingController(text: _o?.maxPerCustomer?.toString() ?? '1');
  late final _total = TextEditingController(text: _o?.maxRedemptions?.toString() ?? '');
  late String _kind = _o?.kind ?? 'percent';
  late DateTime? _starts = _o?.startsAt;
  late DateTime? _ends = _o?.expiresAt;
  late bool _active = _o?.active ?? true;
  bool _saving = false;

  @override
  void dispose() {
    for (final c in [_code, _label, _value, _min, _cap, _perCustomer, _total]) {
      c.dispose();
    }
    super.dispose();
  }

  int? _int(TextEditingController c) => c.text.trim().isEmpty ? null : int.tryParse(c.text.trim());

  Offer _draft() => Offer(
    code: _code.text.trim().toUpperCase(),
    label: _label.text.trim().isEmpty ? null : _label.text.trim(),
    kind: _kind,
    value: _int(_value) ?? 0,
    minOrder: _int(_min) ?? 0,
    maxDiscount: _kind == 'percent' ? _int(_cap) : null,
    active: _active,
    startsAt: _starts,
    expiresAt: _ends,
    maxPerCustomer: _int(_perCustomer),
    maxRedemptions: _int(_total),
  );

  Future<void> _pick(bool start) async {
    final now = DateTime.now();
    final initial = (start ? _starts : _ends) ?? now;
    final day = await showDatePicker(
      context: context,
      firstDate: DateTime(now.year, now.month, now.day),
      lastDate: now.add(const Duration(days: 365)),
      initialDate: initial.isBefore(now) ? now : initial,
    );
    if (day == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: start ? const TimeOfDay(hour: 0, minute: 0) : const TimeOfDay(hour: 23, minute: 59),
    );
    if (time == null) return;
    setState(() {
      final at = DateTime(day.year, day.month, day.day, time.hour, time.minute);
      start ? _starts = at : _ends = at;
    });
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    if (_starts != null && _ends != null && !_starts!.isBefore(_ends!)) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('The offer has to start before it ends.')));
      return;
    }
    setState(() => _saving = true);
    final repo = ref.read(growthRepoProvider);
    final messenger = ScaffoldMessenger.of(context);
    try {
      _o == null ? await repo.createOffer(_draft()) : await repo.updateOffer(_draft());
      ref.invalidate(offersProvider);
      messenger.showSnackBar(SnackBar(content: Text(_o == null ? 'Offer created' : 'Offer saved')));
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.friendly())));
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text('Something went wrong. Try again.')));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _delete() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text('Delete ${_o!.code}?'),
        content: const Text('Customers can\'t use it any more. Orders that already used it keep their discount.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Delete')),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    final ok = await runWrite(
      context,
      ref,
      () => ref.read(growthRepoProvider).deleteOffer(_o!.code),
      done: 'Offer deleted',
    );
    if (ok) {
      ref.invalidate(offersProvider);
      if (mounted) Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final fmt = DateFormat('d MMM y, h:mm a', 'en_IN');
    String? whole(String? v, {bool required = false, int min = 0}) {
      if ((v ?? '').trim().isEmpty) return required ? 'Required' : null;
      final n = int.tryParse(v!.trim());
      return n == null || n < min ? 'Whole number${min > 0 ? ', at least $min' : ''}' : null;
    }

    final preview = _draft();
    return Scaffold(
      appBar: AppBar(
        title: Text(_o == null ? 'New offer' : _o!.code),
        actions: [
          if (_o != null)
            IconButton(tooltip: 'Delete', onPressed: _delete, icon: const Icon(Icons.delete_outline_rounded)),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: FilledButton(
            onPressed: _saving ? null : _save,
            child: Text(_o == null ? 'Create offer' : 'Save changes'),
          ),
        ),
      ),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            Panel(
              tint: c.accentSoft,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Customers will see', style: TextStyle(color: c.muted, fontSize: 12.5)),
                  Text(
                    preview.value > 0 ? preview.headline : '—',
                    style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _code,
              enabled: _o == null,
              textCapitalization: TextCapitalization.characters,
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp('[A-Za-z0-9]'))],
              maxLength: 24,
              decoration: const InputDecoration(
                labelText: 'Code',
                hintText: 'e.g. SPICE20',
                helperText: 'Letters and numbers, 4–24. Unique across Deligro.',
              ),
              validator: (v) => (v ?? '').trim().length < 4 ? 'At least 4 characters' : null,
            ),
            TextFormField(
              controller: _label,
              maxLength: 60,
              decoration: const InputDecoration(labelText: 'Name (optional)', hintText: 'e.g. Diwali special'),
            ),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'percent', label: Text('% off')),
                ButtonSegment(value: 'flat', label: Text('₹ off')),
              ],
              selected: {_kind},
              showSelectedIcon: false,
              onSelectionChanged: (s) => setState(() => _kind = s.first),
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _value,
              keyboardType: TextInputType.number,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(labelText: _kind == 'percent' ? 'Discount (%)' : 'Discount (₹)'),
              validator: (v) {
                final p = whole(v, required: true, min: 1);
                if (p != null) return p;
                if (_kind == 'percent' && int.parse(v!.trim()) > 100) return 'At most 100%';
                return null;
              },
            ),
            if (_kind == 'percent')
              TextFormField(
                controller: _cap,
                keyboardType: TextInputType.number,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(labelText: 'Up to (₹)', helperText: 'Needed for 50% or more'),
                validator: (v) {
                  final p = whole(v, min: 1);
                  if (p != null) return p;
                  final pct = int.tryParse(_value.text.trim()) ?? 0;
                  return pct >= 50 && (v ?? '').trim().isEmpty ? 'Set a cap for 50% or more' : null;
                },
              ),
            TextFormField(
              controller: _min,
              keyboardType: TextInputType.number,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'Minimum order (₹, optional)'),
              validator: (v) => whole(v),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextFormField(
                    controller: _perCustomer,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Uses per customer', helperText: 'Blank = unlimited'),
                    validator: (v) => whole(v, min: 1),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextFormField(
                    controller: _total,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Total uses', helperText: 'Blank = unlimited'),
                    validator: (v) => whole(v, min: 1),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.event_available_rounded),
              title: const Text('Starts'),
              subtitle: Text(_starts == null ? 'Straight away' : fmt.format(_starts!)),
              trailing: _starts == null
                  ? const Icon(Icons.edit_calendar_outlined)
                  : IconButton(onPressed: () => setState(() => _starts = null), icon: const Icon(Icons.close_rounded)),
              onTap: () => _pick(true),
            ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.event_busy_rounded),
              title: const Text('Ends'),
              subtitle: Text(_ends == null ? 'No end date' : fmt.format(_ends!)),
              trailing: _ends == null
                  ? const Icon(Icons.edit_calendar_outlined)
                  : IconButton(onPressed: () => setState(() => _ends = null), icon: const Icon(Icons.close_rounded)),
              onTap: () => _pick(false),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Active'),
              subtitle: const Text('Off pauses it without deleting'),
              value: _active,
              onChanged: (v) => setState(() => _active = v),
            ),
            Text(
              'Your shop pays for this discount: it comes off the order\'s value, and Deligro\'s commission is worked out on what\'s left.',
              style: TextStyle(color: c.muted, fontSize: 12.5),
            ),
          ],
        ),
      ),
    );
  }
}
