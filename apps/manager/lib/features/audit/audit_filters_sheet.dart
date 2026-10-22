import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/audit.dart';
import '../../state/audit.dart';
import '../../state/support.dart';
import '../../theme/app_theme.dart';

/// The audit log's filters: who, which action (a whole group or one action),
/// which kind of thing, which one, and when. Returns null when dismissed.
Future<AuditFilters?> showAuditFiltersSheet(BuildContext context, {required AuditFilters current}) =>
    showModalBottomSheet<AuditFilters>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _AuditFiltersSheet(current: current),
    );

const _entityTypes = {
  'order': 'Order',
  'restaurant': 'Vendor',
  'rider': 'Rider',
  'customer': 'Customer',
  'menu_item': 'Product',
  'ticket': 'Ticket',
  'settlement': 'Settlement',
  'payment_request': 'Payment',
  'coupon': 'Offer',
  'campaign': 'Campaign',
  'alert_rule': 'Alert threshold',
  'zone': 'Zone',
};

class _AuditFiltersSheet extends ConsumerStatefulWidget {
  const _AuditFiltersSheet({required this.current});
  final AuditFilters current;

  @override
  ConsumerState<_AuditFiltersSheet> createState() => _AuditFiltersSheetState();
}

class _AuditFiltersSheetState extends ConsumerState<_AuditFiltersSheet> {
  late AuditFilters _f = widget.current;
  String? _group;
  late final _entityId = TextEditingController(text: widget.current.entityId ?? '');

  @override
  void dispose() {
    _entityId.dispose();
    super.dispose();
  }

  Widget _label(AppColors c, String t) => Padding(
        padding: const EdgeInsets.only(top: 14, bottom: 6),
        child: Text(t, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
      );

  Future<void> _dates() async {
    final today = istToday();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: today.subtract(const Duration(days: 730)),
      lastDate: today,
      initialDateRange: _f.from == null || _f.to == null ? null : DateTimeRange(start: _f.from!, end: _f.to!),
    );
    if (picked != null && mounted) setState(() => _f = _f.copyWith(from: picked.start, to: picked.end));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final catalog = ref.watch(auditActionsProvider).value ?? const <AuditActionDef>[];
    final staff = ref.watch(ticketAssigneesProvider(_f.zoneId)).value?.staff ?? const [];
    final groups = {for (final a in catalog) a.group}.toList();
    final inGroup = _group == null ? const <AuditActionDef>[] : catalog.where((a) => a.group == _group).toList();
    final mixed = _group != null && actionPrefixForGroup(_group!, catalog) == null;
    final fmt = DateFormat('d MMM');
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.9),
        child: SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Filter the audit log', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)),
              if (groups.isNotEmpty) ...[
                _label(c, 'Action'),
                Wrap(spacing: 8, runSpacing: 6, children: [
                  for (final g in groups)
                    ChoiceChip(
                      key: Key('af-group-$g'),
                      label: Text(g),
                      selected: _group == g,
                      onSelected: (on) => setState(() {
                        _group = on ? g : null;
                        _f = _f.copyWith(action: on ? actionPrefixForGroup(g, catalog) : null);
                      }),
                    ),
                ]),
                if (_group != null) ...[
                  if (mixed)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text('Pick an action in this group', style: TextStyle(color: c.muted, fontSize: 12.5)),
                    ),
                  const SizedBox(height: 6),
                  Wrap(spacing: 8, runSpacing: 6, children: [
                    for (final a in inGroup)
                      ChoiceChip(
                        key: Key('af-action-${a.code}'),
                        label: Text(a.label),
                        selected: _f.action == a.code,
                        onSelected: (on) => setState(
                            () => _f = _f.copyWith(action: on ? a.code : actionPrefixForGroup(_group!, catalog))),
                      ),
                  ]),
                ],
              ],
              if (staff.isNotEmpty) ...[
                _label(c, 'Done by'),
                DropdownButtonFormField<String?>(
                  key: const Key('af-actor'),
                  initialValue: staff.any((s) => s.id == _f.actorId) ? _f.actorId : null,
                  isExpanded: true,
                  decoration: const InputDecoration(border: OutlineInputBorder(), isDense: true),
                  items: [
                    const DropdownMenuItem(value: null, child: Text('Anyone')),
                    for (final s in staff) DropdownMenuItem(value: s.id, child: Text(s.name)),
                  ],
                  onChanged: (v) => setState(() => _f = _f.copyWith(actorId: v)),
                ),
              ],
              _label(c, 'Kind of record'),
              Wrap(spacing: 8, runSpacing: 6, children: [
                for (final e in _entityTypes.entries)
                  ChoiceChip(
                    key: Key('af-entity-${e.key}'),
                    label: Text(e.value),
                    selected: _f.entityType == e.key,
                    onSelected: (on) => setState(() => _f = _f.copyWith(entityType: on ? e.key : null)),
                  ),
              ]),
              _label(c, 'Record id'),
              TextField(
                key: const Key('af-entity-id'),
                controller: _entityId,
                decoration: const InputDecoration(hintText: 'Order, vendor or rider id', border: OutlineInputBorder(), isDense: true),
              ),
              _label(c, 'When'),
              Row(children: [
                OutlinedButton.icon(
                  onPressed: _dates,
                  icon: const Icon(Icons.date_range_outlined, size: 18),
                  label: Text(_f.from == null || _f.to == null ? 'Any date' : '${fmt.format(_f.from!)} – ${fmt.format(_f.to!)}'),
                ),
                if (_f.from != null)
                  IconButton(onPressed: () => setState(() => _f = _f.copyWith(from: null, to: null)), icon: const Icon(Icons.close)),
              ]),
              const SizedBox(height: 20),
              Row(children: [
                TextButton(
                  onPressed: () => setState(() {
                    _group = null;
                    _entityId.clear();
                    _f = AuditFilters(zoneId: _f.zoneId);
                  }),
                  child: const Text('Clear'),
                ),
                const Spacer(),
                FilledButton(
                  key: const Key('af-apply'),
                  onPressed: mixed && (_f.action == null || _f.action!.endsWith('.*'))
                      ? null
                      : () {
                          final id = _entityId.text.trim();
                          Navigator.pop(context, _f.copyWith(entityId: id.isEmpty ? null : id));
                        },
                  child: const Text('Show entries'),
                ),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}
