import 'package:flutter/material.dart';

import '../../models/customers.dart';
import '../../theme/app_theme.dart';

/// Why the full number is needed (§10.2, §10.9). Every reveal is recorded
/// with this reason. Returns the reason and, for "Other", a note.
Future<(ContactReason, String?)?> showContactRevealSheet(BuildContext context) =>
    showModalBottomSheet<(ContactReason, String?)>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const _RevealSheet(),
    );

class _RevealSheet extends StatefulWidget {
  const _RevealSheet();

  @override
  State<_RevealSheet> createState() => _RevealSheetState();
}

class _RevealSheetState extends State<_RevealSheet> {
  ContactReason? _reason;
  final _note = TextEditingController();

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  bool get _ok {
    if (_reason == null) return false;
    if (_reason != ContactReason.other) return true;
    final n = _note.text.trim().length;
    return n >= 3 && n <= 200;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 0, 16, 12 + MediaQuery.viewInsetsOf(context).bottom),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Show the full contact?', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text('This is recorded with your name and reason.', style: TextStyle(color: c.muted)),
            const SizedBox(height: 8),
            RadioGroup<ContactReason>(
              groupValue: _reason,
              onChanged: (r) => setState(() => _reason = r),
              child: Column(children: [
                for (final r in ContactReason.values)
                  RadioListTile<ContactReason>(
                    key: Key('reveal-reason-${r.wire}'),
                    value: r,
                    contentPadding: EdgeInsets.zero,
                    title: Text(r.label),
                  ),
              ]),
            ),
            if (_reason == ContactReason.other)
              TextField(
                key: const Key('reveal-note'),
                controller: _note,
                maxLength: 200,
                decoration: const InputDecoration(labelText: 'What for?'),
                onChanged: (_) => setState(() {}),
              ),
            const SizedBox(height: 8),
            FilledButton(
              key: const Key('reveal-submit'),
              onPressed: _ok ? () => Navigator.pop(context, (_reason!, _reason == ContactReason.other ? _note.text.trim() : null)) : null,
              child: const Text('Show contact'),
            ),
          ],
        ),
      ),
    );
  }
}
