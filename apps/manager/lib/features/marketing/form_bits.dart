import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../models/orders.dart' show istOffset, VendorRef;
import '../../models/products.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../state/vendors.dart';
import '../../theme/app_theme.dart';

/// An instant as the IST wall clock: "1 Nov 2026, 9:00 AM".
String istText(DateTime? at, {bool time = true}) {
  if (at == null) return '—';
  final ist = at.toUtc().add(istOffset);
  return DateFormat(time ? 'd MMM y, h:mm a' : 'd MMM y').format(ist);
}

/// An IST calendar date `YYYY-MM-DD` as "1 Nov 2026".
String istDay(String? ymd) {
  final d = ymd == null ? null : DateTime.tryParse(ymd);
  return d == null ? '—' : DateFormat('d MMM y').format(d);
}

/// The UTC instant for an IST wall-clock date and time.
DateTime fromIst(int y, int m, int d, [int h = 0, int min = 0]) => DateTime.utc(y, m, d, h, min).subtract(istOffset);

/// Today's IST date as `YYYY-MM-DD`.
String istToday([DateTime? now]) {
  final ist = (now ?? DateTime.now()).toUtc().add(istOffset);
  return DateFormat('yyyy-MM-dd').format(ist);
}

/// A tappable field showing an IST date and time; picks both.
class IstDateTimeField extends StatelessWidget {
  const IstDateTimeField({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
    this.errorText,
    this.enabled = true,
    this.endOfDay = false,
    this.lastDate,
  });

  final String label;
  final DateTime? value;
  final ValueChanged<DateTime> onChanged;
  final String? errorText;
  final bool enabled;

  /// Default the time to 11:59 PM (an end date) rather than 12:00 AM.
  final bool endOfDay;
  final DateTime? lastDate;

  Future<void> _pick(BuildContext context) async {
    final now = DateTime.now().toUtc().add(istOffset);
    final cur = value?.toUtc().add(istOffset);
    final day = await showDatePicker(
      context: context,
      initialDate: cur ?? now,
      firstDate: DateTime(now.year - 1),
      lastDate: lastDate ?? DateTime(now.year + 2),
    );
    if (day == null || !context.mounted) return;
    final t = await showTimePicker(
      context: context,
      initialTime: cur != null
          ? TimeOfDay(hour: cur.hour, minute: cur.minute)
          : (endOfDay ? const TimeOfDay(hour: 23, minute: 59) : const TimeOfDay(hour: 0, minute: 0)),
    );
    if (t == null) return;
    onChanged(fromIst(day.year, day.month, day.day, t.hour, t.minute));
  }

  @override
  Widget build(BuildContext context) => InkWell(
        key: key == null ? null : Key('${(key as ValueKey).value}-tap'),
        onTap: enabled ? () => _pick(context) : null,
        child: InputDecorator(
          decoration: InputDecoration(
            labelText: '$label (IST)',
            errorText: errorText,
            enabled: enabled,
            suffixIcon: const Icon(Icons.event_outlined),
          ),
          child: Text(value == null ? 'Pick' : istText(value)),
        ),
      );
}

/// Picks one or more shops in scope (Phase 4's vendor directory).
Future<List<VendorRef>?> pickVendors(
  BuildContext context, {
  required List<String> selected,
  bool multi = false,
  int? max,
}) =>
    showModalBottomSheet<List<VendorRef>>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _VendorPickerSheet(selected: selected, multi: multi, max: max),
    );

class _VendorPickerSheet extends ConsumerStatefulWidget {
  const _VendorPickerSheet({required this.selected, required this.multi, this.max});
  final List<String> selected;
  final bool multi;
  final int? max;

  @override
  ConsumerState<_VendorPickerSheet> createState() => _VendorPickerSheetState();
}

class _VendorPickerSheetState extends ConsumerState<_VendorPickerSheet> {
  late final Set<String> _picked = {...widget.selected};
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final dir = ref.watch(vendorDirectoryProvider);
    final all = dir.value ?? const <VendorRef>[];
    final shown = [for (final v in all) if (_q.isEmpty || v.name.toLowerCase().contains(_q)) v];
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.7,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: TextField(
                key: const Key('vendor-picker-search'),
                decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Shop name', isDense: true),
                onChanged: (t) => setState(() => _q = t.trim().toLowerCase()),
              ),
            ),
            Expanded(
              child: dir.isLoading && all.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : ListView(
                      children: [
                        if (dir.hasError) const ListTile(title: Text("Couldn't load the shops. Close and try again.")),
                        for (final v in shown)
                          widget.multi
                              ? CheckboxListTile(
                                  key: Key('vendor-pick-${v.id}'),
                                  value: _picked.contains(v.id),
                                  title: Text(v.name),
                                  onChanged: (on) => setState(() {
                                    if (on == true) {
                                      if (widget.max == null || _picked.length < widget.max!) _picked.add(v.id);
                                    } else {
                                      _picked.remove(v.id);
                                    }
                                  }),
                                )
                              : ListTile(
                                  key: Key('vendor-pick-${v.id}'),
                                  title: Text(v.name),
                                  trailing: _picked.contains(v.id) ? const Icon(Icons.check) : null,
                                  onTap: () => Navigator.pop(context, [v]),
                                ),
                      ],
                    ),
            ),
            if (widget.multi)
              Padding(
                padding: const EdgeInsets.all(12),
                child: FilledButton(
                  key: const Key('vendor-picker-done'),
                  onPressed: () => Navigator.pop(context, [for (final v in all) if (_picked.contains(v.id)) v]),
                  child: Text('Done (${_picked.length})'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Picks dishes of one shop (Phase 4's product list), up to [max].
Future<List<({String id, String name})>?> pickDishes(
  BuildContext context, {
  required String vendorId,
  required List<String> selected,
  int max = 20,
}) =>
    showModalBottomSheet<List<({String id, String name})>>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _DishPickerSheet(vendorId: vendorId, selected: selected, max: max),
    );

class _DishPickerSheet extends ConsumerStatefulWidget {
  const _DishPickerSheet({required this.vendorId, required this.selected, required this.max});
  final String vendorId;
  final List<String> selected;
  final int max;

  @override
  ConsumerState<_DishPickerSheet> createState() => _DishPickerSheetState();
}

class _DishPickerSheetState extends ConsumerState<_DishPickerSheet> {
  late final Map<String, String> _picked = {for (final id in widget.selected) id: ''};
  List<ProductListItem>? _items;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final p = await ref.read(productsRepoProvider).list(ProductFilters(vendorId: widget.vendorId));
      if (mounted) setState(() => _items = p.items);
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final items = _items;
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.7,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: Text('Pick up to ${widget.max} dishes', style: Theme.of(context).textTheme.titleMedium),
            ),
            Expanded(
              child: _error != null
                  ? const Center(child: Text("Couldn't load the dishes."))
                  : items == null
                      ? const Center(child: CircularProgressIndicator())
                      : ListView(
                          children: [
                            for (final d in items)
                              CheckboxListTile(
                                key: Key('dish-pick-${d.id}'),
                                value: _picked.containsKey(d.id),
                                title: Text(d.name),
                                onChanged: (on) => setState(() {
                                  if (on == true && _picked.length < widget.max) {
                                    _picked[d.id] = d.name;
                                  } else if (on != true) {
                                    _picked.remove(d.id);
                                  }
                                }),
                              ),
                          ],
                        ),
            ),
            Padding(
              padding: const EdgeInsets.all(12),
              child: FilledButton(
                key: const Key('dish-picker-done'),
                onPressed: () => Navigator.pop(context, [
                  for (final e in _picked.entries)
                    (id: e.key, name: e.value.isNotEmpty ? e.value : (items?.where((d) => d.id == e.key).firstOrNull?.name ?? 'Dish')),
                ]),
                child: Text('Done (${_picked.length})'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The zones this manager may pick from.
List<({String id, String name})> myZones(WidgetRef ref) {
  final me = ref.read(managerMeProvider).value;
  return [for (final z in me?.zones.zones ?? const []) (id: z.id, name: z.name)];
}

/// A labelled block inside a form.
class FormSection extends StatelessWidget {
  const FormSection({super.key, required this.title, required this.children});
  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              title.toUpperCase(),
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.6, color: context.colors.muted),
            ),
            const SizedBox(height: 8),
            ...children,
          ],
        ),
      );
}

/// "Spice Hub, Bemetara Bakers" / "2 dishes" with a change button.
class PickedRow extends StatelessWidget {
  const PickedRow({super.key, required this.label, required this.value, this.onTap, this.errorText});
  final String label;
  final String value;
  final VoidCallback? onTap;
  final String? errorText;

  @override
  Widget build(BuildContext context) => InkWell(
        onTap: onTap,
        child: InputDecorator(
          decoration: InputDecoration(
            labelText: label,
            errorText: errorText,
            enabled: onTap != null,
            suffixIcon: onTap == null ? const Icon(Icons.lock_outline, size: 18) : const Icon(Icons.chevron_right),
          ),
          child: Text(value.isEmpty ? 'Pick' : value, maxLines: 2, overflow: TextOverflow.ellipsis),
        ),
      );
}

/// An integer field (rupees, counts); empty reads as null.
class IntField extends StatelessWidget {
  const IntField({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
    this.errorText,
    this.enabled = true,
    this.prefix,
    this.helper,
  });
  final String label;
  final int? value;
  final ValueChanged<int?> onChanged;
  final String? errorText;
  final bool enabled;
  final String? prefix;
  final String? helper;

  @override
  Widget build(BuildContext context) => TextFormField(
        key: key == null ? null : Key('${(key as ValueKey).value}-input'),
        initialValue: value?.toString() ?? '',
        enabled: enabled,
        keyboardType: TextInputType.number,
        decoration: InputDecoration(labelText: label, errorText: errorText, prefixText: prefix, helperText: helper),
        onChanged: (t) => onChanged(int.tryParse(t.trim())),
      );
}
