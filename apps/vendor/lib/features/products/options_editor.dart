import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../models/menu.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

/// Sizes (one is chosen; its price is the item's price) and add-on groups
/// (pick between min and max; each add-on adds its price). Edits stay local
/// until the item is saved; ids are kept so customers' carts stay valid.
class OptionsEditor extends ConsumerWidget {
  const OptionsEditor({super.key, required this.variants, required this.groups, required this.onChanged});

  final List<MenuOption> variants;
  final List<AddonGroup> groups;
  final void Function(List<MenuOption> variants, List<AddonGroup> groups) onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Panel(
          padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Sizes', style: const TextStyle(fontWeight: FontWeight.w800)),
              Text(
                'e.g. Half / Full, Regular / Large. The customer must pick one.',
                style: TextStyle(color: c.muted, fontSize: 12.5),
              ),
              for (final (i, v) in variants.indexed)
                _OptionRow(
                  option: v,
                  onEdit: () async {
                    final next = await editOption(context, ref, v, sizePrice: true);
                    if (next != null) onChanged([...variants]..[i] = next, groups);
                  },
                  onDelete: () => onChanged([...variants]..removeAt(i), groups),
                ),
              TextButton.icon(
                onPressed: variants.length >= 20
                    ? null
                    : () async {
                        final v = await editOption(context, ref, null, sizePrice: true);
                        if (v != null) onChanged([...variants, v], groups);
                      },
                icon: const Icon(Icons.add_rounded, size: 18),
                label: Text('Add size'),
              ),
            ],
          ),
        ),
        for (final (gi, g) in groups.indexed) ...[
          const SizedBox(height: 10),
          Panel(
            padding: const EdgeInsets.fromLTRB(16, 12, 8, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(g.name, style: const TextStyle(fontWeight: FontWeight.w800)),
                          Text(_rule(ref, g), style: TextStyle(color: c.muted, fontSize: 12.5)),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: 'Edit group',
                      icon: const Icon(Icons.edit_outlined, size: 20),
                      onPressed: () async {
                        final next = await _editGroup(context, ref, g);
                        if (next != null) onChanged(variants, [...groups]..[gi] = next);
                      },
                    ),
                    IconButton(
                      tooltip: 'Remove group',
                      icon: const Icon(Icons.delete_outline_rounded, size: 20),
                      onPressed: () => onChanged(variants, [...groups]..removeAt(gi)),
                    ),
                  ],
                ),
                for (final (ai, a) in g.addons.indexed)
                  _OptionRow(
                    option: a,
                    plus: true,
                    onEdit: () async {
                      final next = await editOption(context, ref, a, sizePrice: false);
                      if (next != null) {
                        onChanged(variants, [...groups]..[gi] = _withAddons(g, [...g.addons]..[ai] = next));
                      }
                    },
                    onDelete: g.addons.length <= 1 || g.addons.length - 1 < g.minSelect
                        ? null
                        : () => onChanged(variants, [...groups]..[gi] = _withAddons(g, [...g.addons]..removeAt(ai))),
                  ),
                TextButton.icon(
                  onPressed: g.addons.length >= 30
                      ? null
                      : () async {
                          final a = await editOption(context, ref, null, sizePrice: false);
                          if (a != null) onChanged(variants, [...groups]..[gi] = _withAddons(g, [...g.addons, a]));
                        },
                  icon: const Icon(Icons.add_rounded, size: 18),
                  label: Text('Add add-on'),
                ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 6),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: OutlinedButton.icon(
            onPressed: groups.length >= 10
                ? null
                : () async {
                    final g = await _editGroup(context, ref, null);
                    if (g != null) onChanged(variants, [...groups, g]);
                  },
            icon: const Icon(Icons.playlist_add_rounded),
            label: Text('Add add-on group'),
          ),
        ),
      ],
    );
  }

  static AddonGroup _withAddons(AddonGroup g, List<MenuOption> addons) =>
      AddonGroup(id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, addons: addons);

  static String _rule(WidgetRef ref, AddonGroup g) {
    if (g.minSelect == 0) {
      return g.maxSelect == 1 ? 'Optional · pick up to 1' : 'Optional · pick up to ${g.maxSelect}';
    }
    if (g.minSelect == g.maxSelect) return 'Required · pick ${g.minSelect}';
    return 'Required · pick ${g.minSelect}–${g.maxSelect}';
  }

  /// A group's name and pick rule; its add-ons are edited on the card. A
  /// new group needs its first add-on here, since a group can't be empty.
  Future<AddonGroup?> _editGroup(BuildContext context, WidgetRef ref, AddonGroup? g) async {
    final name = TextEditingController(text: g?.name ?? '');
    final first = TextEditingController();
    final firstPrice = TextEditingController(text: '0');
    var required = (g?.minSelect ?? 0) > 0;
    var max = g?.maxSelect ?? 1;
    final form = GlobalKey<FormState>();
    final result = await showDialog<AddonGroup>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (d, set) {
          final addonCount = g?.addons.length ?? 1;
          return AlertDialog(
            title: Text(g == null ? 'New add-on group' : 'Edit group'),
            content: Form(
              key: form,
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextFormField(
                      controller: name,
                      autofocus: true,
                      maxLength: 60,
                      decoration: InputDecoration(labelText: 'Group name', hintText: 'e.g. Extra toppings'),
                      validator: (v) => (v ?? '').trim().isEmpty ? 'Required' : null,
                    ),
                    if (g == null) ...[
                      TextFormField(
                        controller: first,
                        maxLength: 60,
                        decoration: InputDecoration(labelText: 'First add-on'),
                        validator: (v) => (v ?? '').trim().isEmpty ? 'Required' : null,
                      ),
                      TextFormField(
                        controller: firstPrice,
                        keyboardType: TextInputType.number,
                        decoration: InputDecoration(labelText: 'Its price (₹)'),
                        validator: (v) => (int.tryParse((v ?? '').trim()) ?? -1) < 0 ? 'Whole rupees' : null,
                      ),
                    ],
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text('Customer must choose'),
                      value: required,
                      onChanged: (v) => set(() => required = v),
                    ),
                    Row(
                      children: [
                        Expanded(child: Text('Most they can pick')),
                        IconButton(
                          onPressed: max > 1 ? () => set(() => max--) : null,
                          icon: const Icon(Icons.remove_rounded),
                        ),
                        Text('$max', style: const TextStyle(fontWeight: FontWeight.w800)),
                        IconButton(
                          onPressed: max < 30 ? () => set(() => max++) : null,
                          icon: const Icon(Icons.add_rounded),
                        ),
                      ],
                    ),
                    if (required && addonCount < 1) Text('Add at least one add-on'),
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(d), child: Text('Cancel')),
              FilledButton(
                onPressed: () {
                  if (!form.currentState!.validate()) return;
                  final addons =
                      g?.addons ?? [MenuOption(name: first.text.trim(), price: int.parse(firstPrice.text.trim()))];
                  Navigator.pop(
                    d,
                    AddonGroup(
                      id: g?.id,
                      name: name.text.trim(),
                      minSelect: required ? 1 : 0,
                      maxSelect: max,
                      addons: addons,
                    ),
                  );
                },
                child: Text('Done'),
              ),
            ],
          );
        },
      ),
    );
    return result;
  }
}

/// Edit (or create, when [option] is null) a size or an add-on.
Future<MenuOption?> editOption(
  BuildContext context,
  WidgetRef ref,
  MenuOption? option, {
  required bool sizePrice,
}) async {
  final name = TextEditingController(text: option?.name ?? '');
  final price = TextEditingController(text: option == null ? '' : '${option.price}');
  var available = option?.available ?? true;
  final form = GlobalKey<FormState>();
  final result = await showDialog<MenuOption>(
    context: context,
    builder: (d) => StatefulBuilder(
      builder: (d, set) => AlertDialog(
        title: Text(
          sizePrice ? (option == null ? 'New size' : 'Edit size') : (option == null ? 'New add-on' : 'Edit add-on'),
        ),
        content: Form(
          key: form,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                controller: name,
                autofocus: true,
                maxLength: 60,
                decoration: InputDecoration(labelText: 'Name', hintText: sizePrice ? 'e.g. Full' : 'e.g. Extra cheese'),
                validator: (v) => (v ?? '').trim().isEmpty ? 'Required' : null,
              ),
              TextFormField(
                controller: price,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(labelText: sizePrice ? 'Price of this size (₹)' : 'Extra price (₹)'),
                validator: (v) {
                  final n = int.tryParse((v ?? '').trim());
                  return n == null || n < 0 || n > 100000 ? 'Whole rupees' : null;
                },
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('Available'),
                value: available,
                onChanged: (v) => set(() => available = v),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: Text('Cancel')),
          FilledButton(
            onPressed: () {
              if (!form.currentState!.validate()) return;
              Navigator.pop(
                d,
                MenuOption(
                  id: option?.id,
                  name: name.text.trim(),
                  price: int.parse(price.text.trim()),
                  available: available,
                ),
              );
            },
            child: Text('Done'),
          ),
        ],
      ),
    ),
  );
  return result;
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({required this.option, required this.onEdit, this.onDelete, this.plus = false});

  final MenuOption option;
  final VoidCallback onEdit;
  final VoidCallback? onDelete;
  final bool plus;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      onTap: onEdit,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          children: [
            Expanded(
              child: Text(
                option.name,
                style: TextStyle(
                  decoration: option.available ? null : TextDecoration.lineThrough,
                  color: option.available ? c.ink : c.muted,
                ),
              ),
            ),
            Text('${plus ? '+' : ''}${rupees(option.price)}', style: const TextStyle(fontWeight: FontWeight.w700)),
            IconButton(
              icon: const Icon(Icons.close_rounded, size: 18),
              onPressed: onDelete,
              visualDensity: VisualDensity.compact,
            ),
          ],
        ),
      ),
    );
  }
}
