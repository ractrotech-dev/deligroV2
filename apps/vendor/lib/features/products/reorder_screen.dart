import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n.dart';
import '../../models/menu.dart';
import '../../state/menu.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';
import 'products_screen.dart';

/// Drag items into the order customers see them in.
class ReorderScreen extends ConsumerStatefulWidget {
  const ReorderScreen({super.key});

  @override
  ConsumerState<ReorderScreen> createState() => _ReorderScreenState();
}

class _ReorderScreenState extends ConsumerState<ReorderScreen> {
  List<MenuItem>? _items;
  bool _saving = false;

  Future<void> _save() async {
    final items = _items;
    if (items == null) return;
    setState(() => _saving = true);
    final ok = await runWrite(context, ref, () => ref.read(menuRepoProvider).reorder([for (final i in items) i.id]),
        doneEn: 'Menu order saved', doneHi: 'मेन्यू का क्रम सेव हुआ');
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok) {
      await ref.read(menuProvider.notifier).refresh();
      if (mounted) Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final menu = ref.watch(menuProvider).value;
    final items = _items ??= menu == null ? null : [...menu.items];
    return Scaffold(
      appBar: AppBar(
        title: Text(tr(ref, 'Menu order', 'मेन्यू का क्रम')),
        actions: [
          TextButton(
            onPressed: _saving || items == null ? null : _save,
            child: Text(tr(ref, 'Save', 'सेव करें')),
          ),
        ],
      ),
      body: items == null
          ? const Center(child: CircularProgressIndicator())
          : ReorderableListView.builder(
              padding: const EdgeInsets.only(bottom: 32),
              header: Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
                child: Text(tr(ref, 'Hold and drag an item. Customers see the menu in this order.',
                    'आइटम को दबाकर खींचें। ग्राहकों को मेन्यू इसी क्रम में दिखेगा।'),
                    style: TextStyle(color: c.muted)),
              ),
              itemCount: items.length,
              onReorderItem: (from, to) => setState(() => items.insert(to, items.removeAt(from))),
              itemBuilder: (_, i) => ListTile(
                key: ValueKey(items[i].id),
                leading: VegMark(veg: items[i].veg),
                title: Text(items[i].name, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text(items[i].category),
                trailing: const Icon(Icons.drag_handle_rounded),
              ),
            ),
    );
  }
}
