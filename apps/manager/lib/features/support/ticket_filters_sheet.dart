import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/orders.dart' show TicketPriority, VendorRef;
import '../../models/support_ops.dart';
import '../../models/tickets.dart';
import '../../state/vendors.dart';
import '../../theme/app_theme.dart';
import 'ticket_labels.dart';

/// The support queue's filters: issue type, priority, who raised it, when,
/// team and vendor. Returns the new filters, or null when dismissed.
Future<TicketFilters?> showTicketFiltersSheet(
  BuildContext context, {
  required TicketFilters current,
  required List<String> categories,
}) =>
    showModalBottomSheet<TicketFilters>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _FiltersSheet(current: current, categories: categories),
    );

class _FiltersSheet extends ConsumerStatefulWidget {
  const _FiltersSheet({required this.current, required this.categories});
  final TicketFilters current;
  final List<String> categories;

  @override
  ConsumerState<_FiltersSheet> createState() => _FiltersSheetState();
}

class _FiltersSheetState extends ConsumerState<_FiltersSheet> {
  late TicketFilters _f = widget.current;

  static const _roles = {'customer': 'Customer', 'restaurant': 'Vendor', 'driver': 'Rider'};

  Set<String> _toggle(Set<String> s, String v) => s.contains(v) ? ({...s}..remove(v)) : {...s, v};

  Future<void> _pickDates() async {
    final today = istToday();
    final picked = await showDateRangePicker(
      context: context,
      firstDate: today.subtract(const Duration(days: 366)),
      lastDate: today,
      initialDateRange: _f.from == null || _f.to == null ? null : DateTimeRange(start: _f.from!, end: _f.to!),
    );
    if (picked != null && mounted) setState(() => _f = _f.copyWith(from: picked.start, to: picked.end));
  }

  Widget _label(AppColors c, String t) => Padding(
        padding: const EdgeInsets.only(top: 14, bottom: 6),
        child: Text(t, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
      );

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final vendors = ref.watch(vendorDirectoryProvider).value ?? const <VendorRef>[];
    final cats = {...widget.categories, ?_f.category}.toList()..sort();
    final fmt = DateFormat('d MMM');
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.88),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Filter tickets', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)),
              _label(c, 'Priority'),
              Wrap(spacing: 8, children: [
                for (final p in TicketPriority.values)
                  FilterChip(
                    key: Key('tf-priority-${p.name}'),
                    label: Text(priorityLabel(p)),
                    selected: _f.priorities.contains(p.name),
                    onSelected: (_) => setState(() => _f = _f.copyWith(priorities: _toggle(_f.priorities, p.name))),
                  ),
              ]),
              _label(c, 'Raised by'),
              Wrap(spacing: 8, children: [
                for (final r in _roles.entries)
                  FilterChip(
                    key: Key('tf-role-${r.key}'),
                    label: Text(r.value),
                    selected: _f.requesterRoles.contains(r.key),
                    onSelected: (_) =>
                        setState(() => _f = _f.copyWith(requesterRoles: _toggle(_f.requesterRoles, r.key))),
                  ),
              ]),
              if (cats.isNotEmpty) ...[
                _label(c, 'Issue type'),
                Wrap(spacing: 8, runSpacing: 6, children: [
                  for (final k in cats)
                    ChoiceChip(
                      key: Key('tf-category-$k'),
                      label: Text(categoryLabel(k)),
                      selected: _f.category == k,
                      onSelected: (on) => setState(() => _f = _f.copyWith(category: on ? k : null)),
                    ),
                ]),
              ],
              _label(c, 'Team'),
              Wrap(spacing: 8, runSpacing: 6, children: [
                for (final t in TicketTeam.values)
                  ChoiceChip(
                    key: Key('tf-team-${t.wire}'),
                    label: Text(t.label),
                    selected: _f.team == t,
                    onSelected: (on) => setState(() => _f = _f.copyWith(team: on ? t : null)),
                  ),
              ]),
              _label(c, 'Raised between'),
              Row(children: [
                OutlinedButton.icon(
                  key: const Key('tf-dates'),
                  onPressed: _pickDates,
                  icon: const Icon(Icons.date_range_outlined, size: 18),
                  label: Text(_f.from == null || _f.to == null
                      ? 'Any date'
                      : '${fmt.format(_f.from!)} – ${fmt.format(_f.to!)}'),
                ),
                if (_f.from != null)
                  IconButton(
                    tooltip: 'Any date',
                    onPressed: () => setState(() => _f = _f.copyWith(from: null, to: null)),
                    icon: const Icon(Icons.close),
                  ),
              ]),
              if (vendors.isNotEmpty) ...[
                _label(c, 'Vendor'),
                DropdownButtonFormField<String?>(
                  key: const Key('tf-vendor'),
                  initialValue: vendors.any((v) => v.id == _f.vendorId) ? _f.vendorId : null,
                  isExpanded: true,
                  decoration: const InputDecoration(border: OutlineInputBorder(), isDense: true),
                  items: [
                    const DropdownMenuItem(value: null, child: Text('Any vendor')),
                    for (final v in vendors) DropdownMenuItem(value: v.id, child: Text(v.name)),
                  ],
                  onChanged: (v) => setState(() => _f = _f.copyWith(vendorId: v)),
                ),
              ],
              if (_f.riderId != null) ...[
                _label(c, 'Rider'),
                InputChip(
                  key: const Key('tf-rider'),
                  label: const Text('One rider'),
                  onDeleted: () => setState(() => _f = _f.copyWith(riderId: null)),
                ),
              ],
              const SizedBox(height: 20),
              Row(children: [
                TextButton(
                  key: const Key('tf-clear'),
                  onPressed: () => setState(() => _f = TicketFilters(
                        statuses: _f.statuses,
                        assignee: _f.assignee,
                        zoneId: _f.zoneId,
                        q: _f.q,
                      )),
                  child: const Text('Clear'),
                ),
                const Spacer(),
                FilledButton(
                  key: const Key('tf-apply'),
                  onPressed: () => Navigator.pop(context, _f),
                  child: const Text('Show tickets'),
                ),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}
