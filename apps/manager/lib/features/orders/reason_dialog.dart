import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';

/// Quick picks for each intervention — one tap fills the reason, and the
/// manager can still edit it.
abstract final class ReasonPicks {
  static const cancel = ['Customer asked to cancel', 'Shop closed', 'Item unavailable', 'Duplicate order'];
  static const reassign = ['Rider not responding', 'Rider vehicle issue', 'Rider too far', 'Customer requested'];
  static const correct = ['Wrong status tapped', 'Confirmed by phone', 'Rider/vendor mistake'];
  static const escalate = ['Customer complaint', 'Food quality', 'Payment problem', 'Safety concern'];
  static const intervention = [
    'Confirmed with kitchen by phone',
    'Confirmed with rider by phone',
    'Customer confirmed delivery',
  ];
}

/// Asks why. Returns the trimmed text, or null if the manager backed out.
///
/// When [required], Submit stays off until there are at least [minLength]
/// characters (the server refuses shorter with `reason_required`).
Future<String?> showReasonDialog(
  BuildContext context, {
  required String title,
  List<String> quickPicks = const [],
  bool required = true,
  String hint = 'Reason',
  String submitLabel = 'Submit',
  String? message,
  int minLength = 3,
  int maxLength = 300,
  String? initialText,
  String? errorText,
}) =>
    showDialog<String>(
      context: context,
      builder: (_) => _ReasonDialog(
        initialText: initialText,
        errorText: errorText,
        title: title,
        quickPicks: quickPicks,
        required: required,
        hint: hint,
        submitLabel: submitLabel,
        message: message,
        minLength: minLength,
        maxLength: maxLength,
      ),
    );

class _ReasonDialog extends StatefulWidget {
  const _ReasonDialog({
    this.initialText,
    this.errorText,
    required this.title,
    required this.quickPicks,
    required this.required,
    required this.hint,
    required this.submitLabel,
    required this.message,
    required this.minLength,
    required this.maxLength,
  });

  final String title;
  final List<String> quickPicks;
  final bool required;
  final String hint;
  final String submitLabel;
  final String? message;
  final int minLength;
  final int maxLength;

  /// What the manager wrote last time, when the server sent it back.
  final String? initialText;

  /// The server's complaint about that text, shown under the field.
  final String? errorText;

  @override
  State<_ReasonDialog> createState() => _ReasonDialogState();
}

class _ReasonDialogState extends State<_ReasonDialog> {
  late final _text = TextEditingController(text: widget.initialText);

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  bool get _ok => !widget.required || _text.text.trim().length >= widget.minLength;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return AlertDialog(
      title: Text(widget.title),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (widget.message != null) ...[
              Text(widget.message!, style: TextStyle(color: c.ink, height: 1.4)),
              const SizedBox(height: 12),
            ],
            if (widget.quickPicks.isNotEmpty) ...[
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final p in widget.quickPicks)
                    ActionChip(
                      label: Text(p),
                      onPressed: () => setState(() {
                        _text.text = p;
                        _text.selection = TextSelection.collapsed(offset: p.length);
                      }),
                    ),
                ],
              ),
              const SizedBox(height: 12),
            ],
            TextField(
              key: const Key('reason-field'),
              controller: _text,
              autofocus: widget.quickPicks.isEmpty,
              minLines: 2,
              maxLines: 4,
              maxLength: widget.maxLength,
              textCapitalization: TextCapitalization.sentences,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                hintText: widget.hint,
                border: const OutlineInputBorder(),
                helperText: widget.required ? 'At least ${widget.minLength} characters' : null,
                errorText: widget.errorText,
                errorMaxLines: 3,
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Back')),
        FilledButton(
          key: const Key('reason-submit'),
          onPressed: _ok ? () => Navigator.pop(context, _text.text.trim()) : null,
          child: Text(widget.submitLabel),
        ),
      ],
    );
  }
}

/// A yes/no question with the consequence spelled out.
Future<bool> confirm(
  BuildContext context, {
  required String title,
  required String message,
  String yes = 'Continue',
  String no = 'Back',
}) async =>
    await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: Text(no)),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(yes)),
        ],
      ),
    ) ??
    false;

/// One choice from a short list, as a sheet. Null if dismissed.
Future<T?> pickOne<T>(
  BuildContext context, {
  required String title,
  required List<(T, String, String?)> options,
}) =>
    showModalBottomSheet<T>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(title, style: Theme.of(ctx).textTheme.titleLarge),
            ),
            for (final (value, label, subtitle) in options)
              ListTile(
                title: Text(label),
                subtitle: subtitle == null ? null : Text(subtitle),
                onTap: () => Navigator.pop(ctx, value),
              ),
          ],
        ),
      ),
    );
