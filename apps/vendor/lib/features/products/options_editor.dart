import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/i18n.dart';
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
              Text(tr(ref, 'Sizes', 'साइज़'), style: const TextStyle(fontWeight: FontWeight.w800)),
              Text(tr(ref, 'e.g. Half / Full, Regular / Large. The customer must pick one.',
                  'जैसे हाफ़ / फ़ुल, रेगुलर / लार्ज। ग्राहक को एक चुनना होगा।'),
                  style: TextStyle(color: c.muted, fontSize: 12.5)),
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
                label: Text(tr(ref, 'Add size', 'साइज़ जोड़ें')),
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
                      tooltip: tr(ref, 'Edit group', 'ग्रुप बदलें'),
                      icon: const Icon(Icons.edit_outlined, size: 20),
                      onPressed: () async {
                        final next = await _editGroup(context, ref, g);
                        if (next != null) onChanged(variants, [...groups]..[gi] = next);
                      },
                    ),
                    IconButton(
                      tooltip: tr(ref, 'Remove group', 'ग्रुप हटाएँ'),
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
                      if (next != null) onChanged(variants, [...groups]..[gi] = _withAddons(g, [...g.addons]..[ai] = next));
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
                  label: Text(tr(ref, 'Add add-on', 'ऐड-ऑन जोड़ें')),
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
            label: Text(tr(ref, 'Add add-on group', 'ऐड-ऑन ग्रुप जोड़ें')),
          ),
        ),
      ],
    );
  }

  static AddonGroup _withAddons(AddonGroup g, List<MenuOption> addons) =>
      AddonGroup(id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, addons: addons);

  static String _rule(WidgetRef ref, AddonGroup g) {
    if (g.minSelect == 0) {
      return g.maxSelect == 1 ? tr(ref, 'Optional · pick up to 1', 'वैकल्पिक · 1 तक चुनें') : tr(ref, 'Optional · pick up to ${g.maxSelect}', 'वैकल्पिक · ${g.maxSelect} तक चुनें');
    }
    if (g.minSelect == g.maxSelect) return tr(ref, 'Required · pick ${g.minSelect}', 'ज़रूरी · ${g.minSelect} चुनें');
    return tr(ref, 'Required · pick ${g.minSelect}–${g.maxSelect}', 'ज़रूरी · ${g.minSelect}–${g.maxSelect} चुनें');
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
            title: Text(g == null ? trNow(ref, 'New add-on group', 'नया ऐड-ऑन ग्रुप') : trNow(ref, 'Edit group', 'ग्रुप बदलें')),
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
                      decoration: InputDecoration(
                        labelText: trNow(ref, 'Group name', 'ग्रुप का नाम'),
                        hintText: trNow(ref, 'e.g. Extra toppings', 'जैसे एक्स्ट्रा टॉपिंग'),
                      ),
                      validator: (v) => (v ?? '').trim().isEmpty ? trNow(ref, 'Required', 'ज़रूरी है') : null,
                    ),
                    if (g == null) ...[
                      TextFormField(
                        controller: first,
                        maxLength: 60,
                        decoration: InputDecoration(labelText: trNow(ref, 'First add-on', 'पहला ऐड-ऑन')),
                        validator: (v) => (v ?? '').trim().isEmpty ? trNow(ref, 'Required', 'ज़रूरी है') : null,
                      ),
                      TextFormField(
                        controller: firstPrice,
                        keyboardType: TextInputType.number,
                        decoration: InputDecoration(labelText: trNow(ref, 'Its price (₹)', 'इसकी कीमत (₹)')),
                        validator: (v) => (int.tryParse((v ?? '').trim()) ?? -1) < 0 ? trNow(ref, 'Whole rupees', 'पूरे रुपये') : null,
                      ),
                    ],
                    SwitchListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Text(trNow(ref, 'Customer must choose', 'ग्राहक को चुनना ज़रूरी')),
                      value: required,
                      onChanged: (v) => set(() => required = v),
                    ),
                    Row(
                      children: [
                        Expanded(child: Text(trNow(ref, 'Most they can pick', 'ज़्यादा से ज़्यादा'))),
                        IconButton(onPressed: max > 1 ? () => set(() => max--) : null, icon: const Icon(Icons.remove_rounded)),
                        Text('$max', style: const TextStyle(fontWeight: FontWeight.w800)),
                        IconButton(onPressed: max < 30 ? () => set(() => max++) : null, icon: const Icon(Icons.add_rounded)),
                      ],
                    ),
                    if (required && addonCount < 1)
                      Text(trNow(ref, 'Add at least one add-on', 'कम से कम एक ऐड-ऑन जोड़ें')),
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(d), child: Text(trNow(ref, 'Cancel', 'रद्द करें'))),
              FilledButton(
                onPressed: () {
                  if (!form.currentState!.validate()) return;
                  final addons = g?.addons ??
                      [MenuOption(name: first.text.trim(), price: int.parse(firstPrice.text.trim()))];
                  Navigator.pop(
                    d,
                    AddonGroup(id: g?.id, name: name.text.trim(), minSelect: required ? 1 : 0, maxSelect: max, addons: addons),
                  );
                },
                child: Text(trNow(ref, 'Done', 'हो गया')),
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
Future<MenuOption?> editOption(BuildContext context, WidgetRef ref, MenuOption? option, {required bool sizePrice}) async {
  final name = TextEditingController(text: option?.name ?? '');
  final price = TextEditingController(text: option == null ? '' : '${option.price}');
  var available = option?.available ?? true;
  final form = GlobalKey<FormState>();
  final result = await showDialog<MenuOption>(
    context: context,
    builder: (d) => StatefulBuilder(
      builder: (d, set) => AlertDialog(
        title: Text(sizePrice
            ? (option == null ? trNow(ref, 'New size', 'नया साइज़') : trNow(ref, 'Edit size', 'साइज़ बदलें'))
            : (option == null ? trNow(ref, 'New add-on', 'नया ऐड-ऑन') : trNow(ref, 'Edit add-on', 'ऐड-ऑन बदलें'))),
        content: Form(
          key: form,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextFormField(
                controller: name,
                autofocus: true,
                maxLength: 60,
                decoration: InputDecoration(
                  labelText: trNow(ref, 'Name', 'नाम'),
                  hintText: sizePrice ? trNow(ref, 'e.g. Full', 'जैसे फ़ुल') : trNow(ref, 'e.g. Extra cheese', 'जैसे एक्स्ट्रा चीज़'),
                ),
                validator: (v) => (v ?? '').trim().isEmpty ? trNow(ref, 'Required', 'ज़रूरी है') : null,
              ),
              TextFormField(
                controller: price,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: sizePrice ? trNow(ref, 'Price of this size (₹)', 'इस साइज़ की कीमत (₹)') : trNow(ref, 'Extra price (₹)', 'अतिरिक्त कीमत (₹)'),
                ),
                validator: (v) {
                  final n = int.tryParse((v ?? '').trim());
                  return n == null || n < 0 || n > 100000 ? trNow(ref, 'Whole rupees', 'पूरे रुपये') : null;
                },
              ),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(trNow(ref, 'Available', 'उपलब्ध')),
                value: available,
                onChanged: (v) => set(() => available = v),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: Text(trNow(ref, 'Cancel', 'रद्द करें'))),
          FilledButton(
            onPressed: () {
              if (!form.currentState!.validate()) return;
              Navigator.pop(d, MenuOption(id: option?.id, name: name.text.trim(), price: int.parse(price.text.trim()), available: available));
            },
            child: Text(trNow(ref, 'Done', 'हो गया')),
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
              child: Text(option.name,
                  style: TextStyle(
                    decoration: option.available ? null : TextDecoration.lineThrough,
                    color: option.available ? c.ink : c.muted,
                  )),
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
