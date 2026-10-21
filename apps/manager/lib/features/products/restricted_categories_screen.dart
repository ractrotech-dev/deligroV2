import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../models/outcome.dart';
import '../../models/products.dart';
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
    var rows = const <CategoryRow>[];
    try {
      rows = await ref.read(productCategoriesProvider.future);
    } catch (_) {
      // Suggestions are a convenience; typing a name still works.
    }
    if (!context.mounted) return;
    final known = rows
        .where((c) => !c.restricted)
        .map((c) => c.name)
        .toList()
      ..sort();
    final r = await showDialog<(String, String)>(context: context, builder: (_) => _AddDialog(suggestions: known));
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
  const _AddDialog({this.suggestions = const []});

  /// Categories vendors already use; any other name can still be typed.
  final List<String> suggestions;

  @override
  State<_AddDialog> createState() => _AddDialogState();
}

class _AddDialogState extends State<_AddDialog> {
  final _name = TextEditingController();
  final _reason = TextEditingController();
  final _nameFocus = FocusNode();

  @override
  void dispose() {
    _nameFocus.dispose();
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
        RawAutocomplete<String>(
          textEditingController: _name,
          focusNode: _nameFocus,
          optionsBuilder: (v) {
            final q = v.text.trim().toLowerCase();
            return widget.suggestions.where((s) => q.isEmpty || s.toLowerCase().contains(q)).take(8);
          },
          onSelected: (_) => setState(() {}),
          fieldViewBuilder: (context, controller, focus, onSubmit) => TextField(
            key: const Key('restricted-name'),
            controller: controller,
            focusNode: focus,
            textCapitalization: TextCapitalization.words,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              labelText: 'Category name',
              helperText: 'Pick one vendors use, or type a new name',
              border: OutlineInputBorder(),
            ),
          ),
          optionsViewBuilder: (context, onSelected, options) => Align(
            alignment: Alignment.topLeft,
            child: Material(
              elevation: 4,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 240, maxWidth: 280),
                child: ListView(
                  padding: EdgeInsets.zero,
                  shrinkWrap: true,
                  children: [
                    for (final o in options)
                      ListTile(key: Key('restricted-suggestion-$o'), dense: true, title: Text(o), onTap: () => onSelected(o)),
                  ],
                ),
              ),
            ),
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
