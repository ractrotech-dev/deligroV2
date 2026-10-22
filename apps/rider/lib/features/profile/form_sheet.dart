import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/money.dart';
import '../../state/clock.dart';
import '../../state/profile.dart';
import '../../theme/app_theme.dart';

enum FieldKind { text, choice, date }

/// One input of a [FormSheet].
class FieldSpec {
  const FieldSpec(
    this.id,
    this.label, {
    this.kind = FieldKind.text,
    this.initial = '',
    this.options = const [],
    this.keyboard,
    this.capitalization = TextCapitalization.none,
    this.sensitive = false,
    this.maxLength,
    this.helper,
    this.optional = false,
    this.visibleWhen,
    this.formatters,
    this.minDay,
  });

  final String id;
  final String label;
  final FieldKind kind;
  final String initial;

  /// `(value, label)` pairs of a [FieldKind.choice].
  final List<(String, String)> options;
  final TextInputType? keyboard;
  final TextCapitalization capitalization;

  /// Numbers the rider should not read back off the screen or have suggested
  /// later: hidden while typed (with a Show toggle), no suggestions, no
  /// autofill, no keyboard learning.
  final bool sensitive;
  final int? maxLength;
  final String? helper;
  final bool optional;
  final bool Function(Map<String, String> values)? visibleWhen;
  final List<TextInputFormatter>? formatters;

  /// Earliest day a [FieldKind.date] may be (`YYYY-MM-DD`); today when null.
  final String? minDay;
}

/// Opens [FormSheet] over the tab bar. True when it saved.
Future<bool> showFormSheet(BuildContext context, FormSheet sheet) async =>
    await showModalBottomSheet<bool>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => sheet,
    ) ??
    false;

/// A bottom sheet with a few fields and one button. It checks the fields on
/// the phone first ([validate]), then sends ([onSubmit]); the server's own
/// refusal comes back under the field it names ([serverFields] maps the
/// server's field names to this sheet's ids) or at the bottom. The sheet
/// closes with true once the send worked.
class FormSheet extends StatefulWidget {
  const FormSheet({
    super.key,
    required this.title,
    required this.fields,
    required this.submitLabel,
    required this.onSubmit,
    this.intro,
    this.header,
    this.validate,
    this.serverFields = const {},
  });

  final String title;
  final String? intro;
  final Widget? header;
  final List<FieldSpec> fields;
  final String submitLabel;

  /// Field id -> problem. Empty means fine. Values are as typed.
  final Map<String, String> Function(Map<String, String> values)? validate;
  final Future<void> Function(Map<String, String> values) onSubmit;
  final Map<String, String> serverFields;

  @override
  State<FormSheet> createState() => _FormSheetState();
}

class _FormSheetState extends State<FormSheet> {
  final _controllers = <String, TextEditingController>{};
  final _values = <String, String>{};
  final _errors = <String, String>{};
  final _shown = <String>{};
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    for (final f in widget.fields) {
      _values[f.id] = f.initial;
      if (f.kind == FieldKind.text) {
        _controllers[f.id] = TextEditingController(text: f.initial);
      }
    }
  }

  @override
  void dispose() {
    // Clear before dropping: an account number should not outlive the sheet.
    for (final c in _controllers.values) {
      c.clear();
      c.dispose();
    }
    super.dispose();
  }

  Map<String, String> get _current => {
    for (final f in widget.fields)
      f.id: f.kind == FieldKind.text ? _controllers[f.id]!.text : (_values[f.id] ?? ''),
  };

  bool _visible(FieldSpec f) => f.visibleWhen?.call(_current) ?? true;

  Future<void> _submit() async {
    if (_busy) return;
    final values = _current;
    final errors = <String, String>{};
    for (final f in widget.fields) {
      if (!_visible(f)) continue;
      if (!f.optional && values[f.id]!.trim().isEmpty) {
        errors[f.id] = f.kind == FieldKind.date ? 'Choose a date.' : 'This is needed.';
      }
    }
    if (errors.isEmpty) {
      errors.addAll({
        for (final e in (widget.validate?.call(values) ?? const <String, String>{}).entries)
          if (widget.fields.any((f) => f.id == e.key && _visible(f))) e.key: e.value,
      });
    }
    if (errors.isNotEmpty) {
      setState(() {
        _errors
          ..clear()
          ..addAll(errors);
        _error = null;
      });
      return;
    }
    setState(() {
      _busy = true;
      _errors.clear();
      _error = null;
    });
    final container = ProviderScope.containerOf(context, listen: false);
    try {
      await widget.onSubmit({
        for (final f in widget.fields)
          if (_visible(f)) f.id: values[f.id]!,
      });
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      // Another request for this field is already open (made elsewhere, or a
      // stale screen): re-read, so the row shows it and Edit switches off.
      if (e.code == 'duplicate_pending') refreshProfileIn(container);
      if (!mounted) return;
      final field = widget.serverFields['${e.body['field']}'];
      setState(() {
        _busy = false;
        if (field != null && e.code == 'invalid_value') {
          _errors[field] = e.friendly;
        } else {
          _error = e.friendly;
        }
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = 'Something went wrong. Please try again.';
        });
      }
    }
  }

  Future<void> _pickDate(FieldSpec f) async {
    final now = ProviderScope.containerOf(context, listen: false).read(clockProvider)();
    final today = parseDay(istDayKey(now))!;
    final min = parseDay(f.minDay) ?? today;
    final current = parseDay(_values[f.id]);
    final picked = await showDatePicker(
      context: context,
      initialDate: current != null && !current.isBefore(min) ? current : min,
      firstDate: min,
      lastDate: DateTime(today.year + 30, 12, 31),
    );
    if (picked != null && mounted) {
      setState(() {
        _values[f.id] = dayKeyOf(picked);
        _errors.remove(f.id);
      });
    }
  }

  Widget _field(FieldSpec f) {
    final c = context.colors;
    final error = _errors[f.id];
    switch (f.kind) {
      case FieldKind.choice:
        return Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final (value, label) in f.options)
              ChoiceChip(
                key: Key('${f.id}-$value'),
                label: Text(label),
                selected: _values[f.id] == value,
                onSelected: _busy ? null : (_) => setState(() => _values[f.id] = value),
              ),
          ],
        );
      case FieldKind.date:
        final day = _values[f.id] ?? '';
        return InkWell(
          key: Key('field-${f.id}'),
          onTap: _busy ? null : () => _pickDate(f),
          borderRadius: BorderRadius.circular(radiusBlock),
          child: InputDecorator(
            decoration: InputDecoration(
              labelText: f.label,
              errorText: error,
              suffixIcon: const Icon(Icons.calendar_today_outlined, size: 20),
            ),
            child: Text(
              day.isEmpty ? 'Choose a date' : formatDay(day),
              style: TextStyle(fontSize: 16, color: day.isEmpty ? c.muted : c.ink),
            ),
          ),
        );
      case FieldKind.text:
        final hidden = f.sensitive && !_shown.contains(f.id);
        return TextField(
          key: Key('field-${f.id}'),
          controller: _controllers[f.id],
          enabled: !_busy,
          obscureText: hidden,
          enableSuggestions: !f.sensitive,
          autocorrect: !f.sensitive,
          enableIMEPersonalizedLearning: !f.sensitive,
          keyboardType: f.keyboard,
          textCapitalization: f.capitalization,
          maxLength: f.maxLength,
          inputFormatters: f.formatters,
          onChanged: (_) {
            if (_errors.containsKey(f.id)) setState(() => _errors.remove(f.id));
          },
          decoration: InputDecoration(
            labelText: f.optional ? '${f.label} (optional)' : f.label,
            helperText: f.helper,
            helperMaxLines: 3,
            errorText: error,
            errorMaxLines: 3,
            counterText: '',
            suffixIcon: f.sensitive
                ? IconButton(
                    key: Key('show-${f.id}'),
                    tooltip: hidden ? 'Show' : 'Hide',
                    icon: Icon(hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                    onPressed: () => setState(() => hidden ? _shown.add(f.id) : _shown.remove(f.id)),
                  )
                : null,
          ),
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return PopScope(
      canPop: !_busy,
      child: Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(widget.title, style: Theme.of(context).textTheme.titleLarge),
              if (widget.intro != null) ...[
                const SizedBox(height: 6),
                Text(widget.intro!, style: TextStyle(color: c.muted, height: 1.35)),
              ],
              if (widget.header != null) ...[const SizedBox(height: 14), widget.header!],
              for (final f in widget.fields)
                if (_visible(f)) ...[
                  const SizedBox(height: 14),
                  if (f.kind == FieldKind.choice)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(f.label, style: Theme.of(context).textTheme.labelMedium?.copyWith(color: c.muted)),
                    ),
                  _field(f),
                ],
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, key: const Key('sheet-error'), style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
              ],
              const SizedBox(height: 18),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      key: const Key('sheet-cancel'),
                      onPressed: _busy ? null : () => Navigator.pop(context, false),
                      child: const Text('Cancel'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    flex: 2,
                    child: FilledButton(
                      key: const Key('sheet-submit'),
                      onPressed: _busy ? null : _submit,
                      child: _busy
                          ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                          : Text(widget.submitLabel),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
