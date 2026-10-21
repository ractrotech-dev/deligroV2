import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../models/orders.dart';
import '../../theme/app_theme.dart';
import '../../widgets/zone_picker.dart';
import 'order_labels.dart';

/// The Orders "Filters" sheet: date and time range, vendor, rider, status,
/// payment, zone (§3.3–3.7, §6.11). Returns the new filters, or null if the
/// manager backed out.
///
/// Vendor and rider are picked from the ones in the orders already loaded —
/// there is no vendor or rider directory before Phases 4 and 5 — plus
/// whichever is already selected, so a link's filter can always be cleared.
Future<OrderFilters?> showOrderFiltersSheet(
  BuildContext context, {
  required OrderFilters current,
  required List<VendorRef> vendors,
  required List<RiderRef> riders,
}) =>
    showModalBottomSheet<OrderFilters>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _FiltersSheet(current: current, vendors: vendors, riders: riders),
    );

const _statusWires = ['placed', 'kitchen', 'ready', 'on_the_way', 'delivered', 'cancelled'];
const _paymentWires = ['cod', 'online', 'pending', 'paid', 'failed', 'refunded'];

class _FiltersSheet extends StatefulWidget {
  const _FiltersSheet({required this.current, required this.vendors, required this.riders});
  final OrderFilters current;
  final List<VendorRef> vendors;
  final List<RiderRef> riders;

  @override
  State<_FiltersSheet> createState() => _FiltersSheetState();
}

class _FiltersSheetState extends State<_FiltersSheet> {
  late OrderFilters _f = widget.current;

  String _payment(String w) => switch (w) {
        'cod' => 'Cash',
        'online' => 'Online',
        'pending' => 'Pending',
        'paid' => 'Paid',
        'failed' => 'Failed',
        'refunded' => 'Refunded',
        _ => w,
      };

  Future<DateTime?> _pick(DateTime? initial) async {
    final now = DateTime.now();
    final start = initial?.toLocal() ?? now;
    final day = await showDatePicker(
      context: context,
      initialDate: start,
      firstDate: DateTime(now.year - 3),
      lastDate: now.add(const Duration(days: 1)),
    );
    if (day == null || !mounted) return null;
    final time = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(start));
    if (!mounted) return null;
    final t = time ?? const TimeOfDay(hour: 0, minute: 0);
    return DateTime(day.year, day.month, day.day, t.hour, t.minute).toUtc();
  }

  void _quick(int daysBack, {int span = 1}) {
    final (todayFrom, _) = istDayBounds(DateTime.now());
    final from = todayFrom.subtract(Duration(days: daysBack));
    setState(() => _f = _f.copyWith(from: from, to: from.add(Duration(days: span))));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final fmt = DateFormat('d MMM, h:mm a');
    final vendors = {
      for (final v in widget.vendors) v.id: v.name,
      if (_f.vendorId != null) _f.vendorId!: _f.vendorName ?? widget.current.vendorName ?? 'Selected vendor',
    };
    final riders = {
      for (final r in widget.riders) r.id: r.name,
      if (_f.riderId != null) _f.riderId!: _f.riderName ?? widget.current.riderName ?? 'Selected rider',
    };

    Widget heading(String text) => Padding(
          padding: const EdgeInsets.fromLTRB(0, 18, 0, 8),
          child: Text(text.toUpperCase(),
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.6, color: c.muted)),
        );

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.88),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 12, 4),
                child: Row(
                  children: [
                    Text('Filters', style: Theme.of(context).textTheme.titleLarge),
                    const Spacer(),
                    TextButton(
                      key: const Key('filters-clear'),
                      onPressed: () => setState(() => _f = OrderFilters(q: _f.q, zoneId: _f.zoneId, queue: _f.queue)),
                      child: Text('Clear all'),
                    ),
                  ],
                ),
              ),
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
                  children: [
                    heading('Date & time'),
                    Wrap(spacing: 8, runSpacing: 8, children: [
                      ActionChip(label: Text('Today'), onPressed: () => _quick(0)),
                      ActionChip(label: Text('Yesterday'), onPressed: () => _quick(1)),
                      ActionChip(label: Text('Last 7 days'), onPressed: () => _quick(6, span: 7)),
                    ]),
                    const SizedBox(height: 8),
                    Row(children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          key: const Key('filters-from'),
                          icon: const Icon(Icons.event_outlined, size: 18),
                          label: Text(_f.from == null ? 'From' : fmt.format(_f.from!.toLocal()),
                              overflow: TextOverflow.ellipsis),
                          onPressed: () async {
                            final d = await _pick(_f.from);
                            if (d != null) setState(() => _f = _f.copyWith(from: d));
                          },
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: OutlinedButton.icon(
                          key: const Key('filters-to'),
                          icon: const Icon(Icons.event_outlined, size: 18),
                          label: Text(_f.to == null ? 'To' : fmt.format(_f.to!.toLocal()),
                              overflow: TextOverflow.ellipsis),
                          onPressed: () async {
                            final d = await _pick(_f.to);
                            if (d != null) setState(() => _f = _f.copyWith(to: d));
                          },
                        ),
                      ),
                    ]),
                    if (_f.from != null && _f.to != null && _f.from!.isAfter(_f.to!))
                      Padding(
                        padding: const EdgeInsets.only(top: 6),
                        child: Text('"From" is after "To".',
                            style: TextStyle(color: c.deal, fontSize: 12.5)),
                      ),
                    heading('Vendor'),
                    _Dropdown(
                      keyName: 'filters-vendor',
                      value: _f.vendorId,
                      options: vendors,
                      anyLabel: 'Any vendor',
                      onChanged: (id) => setState(() => _f = _f.copyWith(vendorId: id, vendorName: id == null ? null : vendors[id])),
                    ),
                    heading('Rider'),
                    _Dropdown(
                      keyName: 'filters-rider',
                      value: _f.riderId,
                      options: riders,
                      anyLabel: 'Any rider',
                      onChanged: (id) => setState(() => _f = _f.copyWith(riderId: id, riderName: id == null ? null : riders[id])),
                    ),
                    heading('Status'),
                    Wrap(spacing: 8, runSpacing: 8, children: [
                      for (final w in _statusWires)
                        FilterChip(
                          key: Key('filters-status-$w'),
                          label: Text(statusWireLabel(w)),
                          selected: _f.statuses.contains(w),
                          onSelected: (on) => setState(() => _f = _f.copyWith(
                                statuses: on ? {..._f.statuses, w} : ({..._f.statuses}..remove(w)),
                              )),
                        ),
                    ]),
                    heading('Payment'),
                    Wrap(spacing: 8, runSpacing: 8, children: [
                      for (final w in _paymentWires)
                        FilterChip(
                          key: Key('filters-payment-$w'),
                          label: Text(_payment(w)),
                          selected: _f.payments.contains(w),
                          onSelected: (on) => setState(() => _f = _f.copyWith(
                                payments: on ? {..._f.payments, w} : ({..._f.payments}..remove(w)),
                              )),
                        ),
                    ]),
                    heading('Zone'),
                    const Align(alignment: Alignment.centerLeft, child: ZonePickerChip()),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    key: const Key('filters-apply'),
                    onPressed: _f.from != null && _f.to != null && _f.from!.isAfter(_f.to!)
                        ? null
                        : () => Navigator.pop(context, _f),
                    child: Text('Show orders'),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Dropdown extends StatelessWidget {
  const _Dropdown({required this.keyName, required this.value, required this.options, required this.anyLabel, required this.onChanged});
  final String keyName;
  final String? value;
  final Map<String, String> options;
  final String anyLabel;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) => DropdownButtonFormField<String?>(
        key: Key(keyName),
        initialValue: value,
        isExpanded: true,
        decoration: const InputDecoration(border: OutlineInputBorder(), isDense: true),
        items: [
          DropdownMenuItem<String?>(value: null, child: Text(anyLabel)),
          for (final e in options.entries) DropdownMenuItem<String?>(value: e.key, child: Text(e.value, overflow: TextOverflow.ellipsis)),
        ],
        onChanged: onChanged,
      );
}
