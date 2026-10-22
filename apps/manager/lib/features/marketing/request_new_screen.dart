import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../models/marketing.dart';
import '../../models/outcome.dart';
import '../../state/marketing.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'form_bits.dart';
import 'marketing_labels.dart';

/// "Record a request for a vendor" — a shop asked on the phone, so Deligro
/// writes it down for them (`source = ops`); it then goes through the same
/// review as one sent from the Partner app.
class RequestNewScreen extends ConsumerStatefulWidget {
  const RequestNewScreen({super.key});

  @override
  ConsumerState<RequestNewScreen> createState() => _RequestNewScreenState();
}

class _RequestNewScreenState extends ConsumerState<RequestNewScreen> {
  ({String id, String name})? _vendor;
  MarketingType _type = MarketingType.featuredStore;
  final _title = TextEditingController();
  final _details = TextEditingController();
  DateTime? _start;
  DateTime? _end;
  int? _budget;
  List<({String id, String name})> _items = const [];
  Map<String, String> _errors = const {};
  bool _busy = false;
  NewRequestInput? _pending;

  @override
  void dispose() {
    _title.dispose();
    _details.dispose();
    super.dispose();
  }

  static String? _ymd(DateTime? d) => d == null ? null : DateFormat('yyyy-MM-dd').format(d.toUtc().add(const Duration(hours: 5, minutes: 30)));

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Record a request'), backgroundColor: c.bg),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 120),
        children: [
          Text('For a vendor who asked by phone or in person. It is reviewed like any other request.', style: TextStyle(color: c.muted)),
          FormSection(title: 'Vendor', children: [
            PickedRow(
              key: const Key('new-request-vendor'),
              label: 'Shop',
              value: _vendor?.name ?? '',
              errorText: _errors['vendorId'],
              onTap: () async {
                final p = await pickVendors(context, selected: [?_vendor?.id]);
                if (p != null && p.isNotEmpty) setState(() => _vendor = (id: p.first.id, name: p.first.name));
              },
            ),
          ]),
          FormSection(title: 'What they want', children: [
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final t in MarketingType.pickable)
                ChoiceChip(
                  key: Key('new-request-type-${t.wire}'),
                  label: Text(t.label),
                  selected: _type == t,
                  onSelected: (_) => setState(() => _type = t),
                ),
            ]),
            const SizedBox(height: 8),
            TextField(
              key: const Key('new-request-title'),
              controller: _title,
              maxLength: 80,
              decoration: InputDecoration(labelText: 'Title', errorText: _errors['title']),
            ),
            TextField(
              key: const Key('new-request-details'),
              controller: _details,
              maxLines: 4,
              maxLength: 2000,
              decoration: const InputDecoration(labelText: 'Details'),
            ),
            if (_type == MarketingType.sponsoredProduct)
              PickedRow(
                key: const Key('new-request-dishes'),
                label: 'Dishes',
                value: _items.map((i) => i.name).join(', '),
                onTap: _vendor == null
                    ? null
                    : () async {
                        final p = await pickDishes(context, vendorId: _vendor!.id, selected: [for (final i in _items) i.id]);
                        if (p != null) setState(() => _items = p);
                      },
              ),
          ]),
          FormSection(title: 'Preferred dates and budget (optional)', children: [
            IstDateTimeField(label: 'From', value: _start, onChanged: (d) => setState(() => _start = d)),
            const SizedBox(height: 10),
            IstDateTimeField(label: 'To', value: _end, endOfDay: true, errorText: _errors['preferredEnd'], onChanged: (d) => setState(() => _end = d)),
            IntField(label: 'Budget', prefix: '₹ ', value: _budget, onChanged: (n) => _budget = n),
          ]),
        ],
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          child: FilledButton(
            key: const Key('new-request-save'),
            onPressed: _busy ? null : _save,
            child: Text(_busy ? 'Saving…' : 'Save request'),
          ),
        ),
      ),
    );
  }

  Future<void> _save() async {
    final errors = <String, String>{
      if (_vendor == null) 'vendorId': 'Pick the shop',
      if (_title.text.trim().length < 3) 'title': 'At least 3 characters',
      if (_start != null && _end != null && !_end!.isAfter(_start!)) 'preferredEnd': 'Must be after the start',
    };
    setState(() => _errors = errors);
    if (errors.isNotEmpty) return;
    _pending ??= NewRequestInput(
      vendorId: _vendor!.id,
      type: _type,
      title: _title.text,
      details: _details.text,
      preferredStart: _ymd(_start),
      preferredEnd: _ymd(_end),
      budget: _budget,
      itemIds: [for (final i in _items) i.id],
    );
    setState(() => _busy = true);
    try {
      final out = await ref.read(marketingRepoProvider).createRequest(_pending!);
      if (!mounted) return;
      switch (out) {
        case Applied(:final value):
          ref.invalidate(requestListProvider);
          showSnack(context, 'Request recorded.');
          final router = GoRouter.maybeOf(context);
          if (value != null && router != null) {
            router.pushReplacement('/more/marketing/requests/${value.id}');
          } else {
            Navigator.of(context).pop();
          }
        case Refused(:final code, :final field, :final extra):
          _pending = null;
          setState(() => _errors = {?field: 'Check this field'});
          showSnack(context, marketingRefusal(code, extra));
      }
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (mounted) showSnack(context, '${e.friendly} Tap Save to try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}
