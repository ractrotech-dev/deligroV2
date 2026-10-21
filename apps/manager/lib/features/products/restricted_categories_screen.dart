import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../models/outcome.dart';
import '../../state/products.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../orders/reason_dialog.dart';

/// Categories whose new dishes and price changes need a manager's approval
/// before customers see them (§12.9). `manager.products.moderate` only.
class RestrictedCategoriesScreen extends ConsumerWidget {
  const RestrictedCategoriesScreen({super.key});

  Future<void> _set(BuildContext context, WidgetRef ref, String name, bool restricted, String reason) async {
    final id = const Uuid().v4();
    Future<void> send() async {
      try {
        final out = await ref
            .read(productsRepoProvider)
            .setRestricted(name: name, restricted: restricted, reason: reason, clientActionId: id);
        ref.invalidate(restrictedCategoriesProvider);
        if (!context.mounted) return;
        showSnack(
          context,
          out is Refused
              ? "That didn't go through (${(out as Refused).code})."
              : restricted
              ? '$name now needs approval.'
              : '$name no longer needs approval.',
        );
      } on ApiException catch (e) {
        if (!context.mounted) return;
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(
            SnackBar(
              content: Text(e.friendly),
              action: SnackBarAction(label: 'Retry', onPressed: send),
            ),
          );
      }
    }

    await send();
  }

  Future<void> _add(BuildContext context, WidgetRef ref) async {
    final r = await showDialog<(String, String)>(context: context, builder: (_) => const _AddDialog());
    if (r == null || !context.mounted) return;
    await _set(context, ref, r.$1, true, r.$2);
  }

  Future<void> _remove(BuildContext context, WidgetRef ref, String name) async {
    final reason = await showReasonDialog(
      context,
      title: 'Stop requiring approval for $name?',
      message: 'New dishes and price changes in this category go live at once again.',
      submitLabel: 'Remove',
    );
    if (reason == null || !context.mounted) return;
    await _set(context, ref, name, false, reason);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Restricted categories'), backgroundColor: c.bg),
      floatingActionButton: FloatingActionButton.extended(
        key: const Key('restricted-add'),
        backgroundColor: c.accent,
        foregroundColor: c.onAccent,
        elevation: 2,
        onPressed: () => _add(context, ref),
        icon: const Icon(Icons.add),
        label: const Text('Add category'),
      ),
      body: AsyncView(
        value: ref.watch(restrictedCategoriesProvider),
        onRetry: () => ref.invalidate(restrictedCategoriesProvider),
        builder: (rows) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
          children: [
            Text(
              'New dishes and price changes in these categories stay hidden from customers until a manager approves them.',
              style: TextStyle(color: c.muted, height: 1.4),
            ),
            const SizedBox(height: 8),
            if (rows.isEmpty) const EmptyLine('No restricted categories.'),
            for (final r in rows)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.lock_outline, color: c.deal),
                title: Text(
                  r.name,
                  style: TextStyle(fontWeight: FontWeight.w700, color: c.ink),
                ),
                subtitle: r.note == null ? null : Text(r.note!),
                trailing: IconButton(
                  key: Key('restricted-remove-${r.name}'),
                  tooltip: 'Remove',
                  onPressed: () => _remove(context, ref, r.name),
                  icon: const Icon(Icons.close),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _AddDialog extends StatefulWidget {
  const _AddDialog();

  @override
  State<_AddDialog> createState() => _AddDialogState();
}

class _AddDialogState extends State<_AddDialog> {
  final _name = TextEditingController();
  final _reason = TextEditingController();

  @override
  void dispose() {
    _name.dispose();
    _reason.dispose();
    super.dispose();
  }

  bool get _ok => _name.text.trim().length >= 2 && _reason.text.trim().length >= 3;

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Require approval for a category'),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        TextField(
          key: const Key('restricted-name'),
          controller: _name,
          textCapitalization: TextCapitalization.words,
          onChanged: (_) => setState(() {}),
          decoration: const InputDecoration(
            labelText: 'Category name',
            helperText: 'As vendors write it on their menus',
            border: OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          key: const Key('reason-field'),
          controller: _reason,
          minLines: 2,
          maxLines: 3,
          maxLength: 300,
          onChanged: (_) => setState(() {}),
          decoration: const InputDecoration(labelText: 'Why', border: OutlineInputBorder()),
        ),
      ],
    ),
    actions: [
      TextButton(onPressed: () => Navigator.pop(context), child: const Text('Back')),
      FilledButton(
        key: const Key('reason-submit'),
        onPressed: _ok ? () => Navigator.pop(context, (_name.text.trim(), _reason.text.trim())) : null,
        child: const Text('Add'),
      ),
    ],
  );
}
