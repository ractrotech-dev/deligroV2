import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/report.dart';
import '../../models/rider.dart' show RiderFilters;
import '../../state/providers.dart';
import '../../widgets/zone_picker.dart';

/// The filters a kind takes, in a fixed order. Zone is the app-wide picker.
List<String> reportFilterKeys(ReportKindInfo k) =>
    [for (final f in const ['vendor', 'rider', 'status', 'payment']) if (k.takes(f)) f];

/// Vendor, rider, status and payment — only those the kind takes. Returns
/// the new query, or null when dismissed.
Future<ReportQuery?> showReportFiltersSheet(BuildContext context, ReportKindInfo kind, ReportQuery q) =>
    showModalBottomSheet<ReportQuery>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _FiltersSheet(kind: kind, query: q),
    );

const _paymentChoices = <(String?, String)>[(null, 'All'), ('cod', 'Cash'), ('online', 'Online')];

class _FiltersSheet extends ConsumerStatefulWidget {
  const _FiltersSheet({required this.kind, required this.query});
  final ReportKindInfo kind;
  final ReportQuery query;

  @override
  ConsumerState<_FiltersSheet> createState() => _FiltersSheetState();
}

class _FiltersSheetState extends ConsumerState<_FiltersSheet> {
  late ReportQuery _q = widget.query;
  List<({String id, String name})>? _vendors;
  List<({String id, String name})>? _riders;

  @override
  void initState() {
    super.initState();
    final zone = ref.read(activeZoneProvider)?.id;
    if (widget.kind.takes('vendor')) {
      ref.read(vendorsRepoProvider).directory(zoneId: zone).then((v) {
        if (mounted) setState(() => _vendors = [for (final x in v) (id: x.id, name: x.name)]);
      }, onError: (_) {
        if (mounted) setState(() => _vendors = const []);
      });
    }
    if (widget.kind.takes('rider')) {
      ref.read(ridersRepoProvider).list(RiderFilters(zoneId: zone)).then((p) {
        if (mounted) {
          setState(() => _riders = [for (final r in p.items) (id: r.id, name: [r.name ?? 'Rider', ?r.riderCode].join(' · '))]);
        }
      }, onError: (_) {
        if (mounted) setState(() => _riders = const []);
      });
    }
  }

  Widget _picker(String key, String label, List<({String id, String name})>? options, String? selected,
      void Function(String? id, String? name) onChanged) {
    if (options == null) return const Padding(padding: EdgeInsets.all(8), child: LinearProgressIndicator());
    return DropdownButtonFormField<String?>(
      key: Key('filter-$key'),
      initialValue: options.any((o) => o.id == selected) ? selected : null,
      isExpanded: true,
      decoration: InputDecoration(labelText: label),
      items: [
        const DropdownMenuItem(value: null, child: Text('All')),
        for (final o in options) DropdownMenuItem(value: o.id, child: Text(o.name, overflow: TextOverflow.ellipsis)),
      ],
      onChanged: (id) => onChanged(id, options.where((o) => o.id == id).firstOrNull?.name),
    );
  }

  @override
  Widget build(BuildContext context) {
    final k = widget.kind;
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 24 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Filters', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 12),
        for (final f in reportFilterKeys(k)) ...[
          switch (f) {
            'vendor' => _picker('vendor', 'Vendor', _vendors, _q.vendorId,
                (id, name) => setState(() => _q = _q.copyWith(vendorId: id, vendorName: name, page: 1))),
            'rider' => _picker('rider', 'Rider', _riders, _q.riderId,
                (id, name) => setState(() => _q = _q.copyWith(riderId: id, riderName: name, page: 1))),
            'status' => Wrap(key: const Key('filter-status'), spacing: 8, runSpacing: 6, children: [
                ChoiceChip(
                  label: const Text('Any status'),
                  selected: _q.status == null,
                  onSelected: (_) => setState(() => _q = _q.copyWith(status: null, page: 1)),
                ),
                for (final s in k.statusOptions)
                  ChoiceChip(
                    label: Text(s.replaceAll('_', ' ')),
                    selected: _q.status == s,
                    onSelected: (_) => setState(() => _q = _q.copyWith(status: s, page: 1)),
                  ),
              ]),
            _ => Wrap(key: const Key('filter-payment'), spacing: 8, children: [
                for (final (v, label) in _paymentChoices)
                  ChoiceChip(
                    label: Text(label),
                    selected: _q.payment == v,
                    onSelected: (_) => setState(() => _q = _q.copyWith(payment: v, page: 1)),
                  ),
              ]),
          },
          const SizedBox(height: 12),
        ],
        Row(children: [
          TextButton(
            onPressed: () => setState(() => _q = _q.copyWith(
                vendorId: null, vendorName: null, riderId: null, riderName: null, status: null, payment: null, page: 1)),
            child: const Text('Clear'),
          ),
          const Spacer(),
          FilledButton(key: const Key('filters-apply'), onPressed: () => Navigator.pop(context, _q), child: const Text('Apply')),
        ]),
      ]),
    );
  }
}
