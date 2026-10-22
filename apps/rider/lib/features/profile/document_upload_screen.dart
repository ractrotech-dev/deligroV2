import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/document_file.dart';
import '../../core/errors.dart';
import '../../core/money.dart';
import '../../models/profile.dart';
import '../../state/clock.dart';
import '../../state/profile.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

final _numberRules = <String, RegExp>{
  'aadhaar': RegExp(r'^\d{12}$'),
  'pan': RegExp(r'^[A-Z]{5}\d{4}[A-Z]$'),
  'driving_licence': RegExp(r'^[A-Z0-9-]{8,20}$'),
  'vehicle_rc': RegExp(r'^[A-Z0-9-]{6,15}$'),
};
final _anyNumber = RegExp(r'^[A-Z0-9/-]{1,30}$');

/// A document number as sent: no spaces, upper case, no dashes in an Aadhaar.
String tidyNumber(String type, String raw) {
  var s = raw.replaceAll(RegExp(r'\s+'), '').toUpperCase();
  if (type == 'aadhaar') s = s.replaceAll('-', '');
  return s;
}

/// Why [raw] is not a good number for [type], in words; null when it is fine
/// (or optional and empty).
String? numberProblem(DocType type, String raw) {
  if (type.number == NumberRule.none) return null;
  final s = tidyNumber(type.id, raw);
  if (s.isEmpty) return type.number == NumberRule.required ? 'Enter the ${type.label.toLowerCase()} number.' : null;
  final rule = _numberRules[type.id] ?? _anyNumber;
  if (rule.hasMatch(s)) return null;
  return switch (type.id) {
    'aadhaar' => 'An Aadhaar number has 12 digits.',
    'pan' => 'A PAN looks like ABCDE1234F.',
    _ => 'Check the number. Use letters, numbers and -.',
  };
}

String fileSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).round()} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

String _mimeLabel(String? mime) => switch (mime) {
  'application/pdf' => 'PDF',
  'image/jpeg' => 'JPEG',
  'image/png' => 'PNG',
  _ => 'Unknown type',
};

/// Uploads (or replaces) one document. The file is checked on the phone first:
/// its real type (by its first bytes, never its name), its size, the number
/// and the expiry date. Nothing is sent until all four are fine, and the
/// picked copy is deleted once it is sent or the screen is left.
class DocumentUploadScreen extends ConsumerStatefulWidget {
  const DocumentUploadScreen({super.key, required this.type});

  final String type;

  @override
  ConsumerState<DocumentUploadScreen> createState() => _DocumentUploadScreenState();
}

class _DocumentUploadScreenState extends ConsumerState<DocumentUploadScreen> {
  final _number = TextEditingController();
  PickedDocument? _file;
  String _expiry = '';
  bool _showNumber = false;
  bool _busy = false;
  final _errors = <String, String>{};
  String? _error;

  DocType? get _type => docTypeOf(widget.type);

  @override
  void dispose() {
    _number.clear();
    _number.dispose();
    _discard();
    super.dispose();
  }

  void _discard() {
    final f = _file;
    if (f != null && f.temporary) deleteQuietly(f.path);
    _file = null;
  }

  Future<void> _pick(DocSource source) async {
    if (_busy) return;
    final PickedDocument? picked;
    try {
      picked = await ref.read(documentChooserProvider)(source);
    } catch (_) {
      if (mounted) showSnack(context, source == DocSource.camera ? 'Could not open the camera.' : 'Could not open your files.');
      return;
    }
    if (picked == null || !mounted) return;
    _discard();
    final problem = checkPickedDocument(picked);
    setState(() {
      _file = picked;
      _error = null;
      if (problem == null) {
        _errors.remove('file');
      } else {
        _errors['file'] = friendlyError(problem);
      }
    });
  }

  Future<void> _pickDate() async {
    final now = ref.read(clockProvider)();
    final today = parseDay(istDayKey(now))!;
    final current = parseDay(_expiry);
    final picked = await showDatePicker(
      context: context,
      initialDate: current != null && !current.isBefore(today) ? current : today,
      firstDate: today,
      lastDate: DateTime(today.year + 30, 12, 31),
    );
    if (picked != null && mounted) {
      setState(() {
        _expiry = dayKeyOf(picked);
        _errors.remove('expiry');
      });
    }
  }

  Future<void> _submit() async {
    final type = _type;
    if (type == null || _busy) return;
    final errors = <String, String>{};
    final file = _file;
    if (file == null) {
      errors['file'] = 'Choose a photo or a file first.';
    } else {
      final problem = checkPickedDocument(file);
      if (problem != null) errors['file'] = friendlyError(problem);
    }
    final numberError = numberProblem(type, _number.text);
    if (numberError != null) errors['number'] = numberError;
    if (type.expiry) {
      final today = istDayKey(ref.read(clockProvider)());
      if (_expiry.isEmpty) {
        errors['expiry'] = friendlyError('expiry_required');
      } else if (_expiry.compareTo(today) < 0) {
        errors['expiry'] = friendlyError('invalid_expiry');
      }
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
    final number = tidyNumber(type.id, _number.text);
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    try {
      await ref.read(profileRepoProvider).uploadDocument(
        type: type.id,
        number: number.isEmpty ? null : number,
        expiresOn: type.expiry ? _expiry : null,
        file: file!,
      );
      refreshProfile(ref);
      _discard();
      if (!mounted) return;
      navigator.pop();
      messenger
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text('${type.label} sent. Waiting for Deligro.')));
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        switch (e.code) {
          case 'bad_type' || 'too_large':
            _errors['file'] = e.friendly;
          case 'invalid_number':
            _errors['number'] = e.friendly;
          case 'expiry_required' || 'invalid_expiry':
            _errors['expiry'] = e.friendly;
          default:
            _error = e.friendly;
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final type = _type;
    if (type == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Upload')),
        body: const EmptyState(icon: Icons.help_outline_rounded, title: 'We could not find that document type'),
      );
    }
    final existing = ref.watch(riderProfileProvider).value?.documentOf(type.id);
    final file = _file;
    final hidden = type.id == 'aadhaar' && !_showNumber;
    return Scaffold(
      appBar: AppBar(title: Text('Upload ${type.label}')),
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            if (existing != null)
              Panel(
                key: const Key('replace-note'),
                child: Row(
                  children: [
                    Icon(Icons.info_outline_rounded, color: c.muted),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'This replaces your current ${type.label.toLowerCase()}. Deligro will check the new one again.',
                        style: const TextStyle(height: 1.35),
                      ),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 16),
            Text('The file', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 4),
            Text('PDF, JPEG or PNG, up to 10 MB.', style: TextStyle(color: c.muted)),
            const SizedBox(height: 12),
            if (file == null)
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      key: const Key('pick-camera'),
                      onPressed: _busy ? null : () => _pick(DocSource.camera),
                      icon: const Icon(Icons.photo_camera_outlined),
                      label: const Text('Take a photo'),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: OutlinedButton.icon(
                      key: const Key('pick-file'),
                      onPressed: _busy ? null : () => _pick(DocSource.file),
                      icon: const Icon(Icons.attach_file_rounded),
                      label: const Text('Choose a file'),
                    ),
                  ),
                ],
              )
            else
              Container(
                key: const Key('picked-file'),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: c.surface,
                  borderRadius: BorderRadius.circular(radiusBlock),
                  border: Border.all(color: _errors.containsKey('file') ? c.deal : c.line),
                ),
                child: Row(
                  children: [
                    Icon(
                      file.mime == 'application/pdf' ? Icons.picture_as_pdf_outlined : Icons.image_outlined,
                      color: c.muted,
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(file.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                          Text('${fileSize(file.size)} · ${_mimeLabel(file.mime)}', style: TextStyle(color: c.muted, fontSize: 13)),
                        ],
                      ),
                    ),
                    TextButton(
                      key: const Key('remove-file'),
                      onPressed: _busy
                          ? null
                          : () => setState(() {
                              _discard();
                              _errors.remove('file');
                            }),
                      child: const Text('Remove'),
                    ),
                  ],
                ),
              ),
            if (_errors['file'] != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_errors['file']!, key: const Key('error-file'), style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
              ),
            if (type.number != NumberRule.none) ...[
              const SizedBox(height: 20),
              TextField(
                key: const Key('field-number'),
                controller: _number,
                enabled: !_busy,
                obscureText: hidden,
                enableSuggestions: false,
                autocorrect: false,
                enableIMEPersonalizedLearning: false,
                keyboardType: type.id == 'aadhaar' ? TextInputType.number : TextInputType.text,
                textCapitalization: TextCapitalization.characters,
                inputFormatters: type.id == 'aadhaar' ? [FilteringTextInputFormatter.allow(RegExp(r'[0-9 -]'))] : null,
                maxLength: type.id == 'aadhaar' ? 14 : 24,
                onChanged: (_) {
                  if (_errors.containsKey('number')) setState(() => _errors.remove('number'));
                },
                decoration: InputDecoration(
                  labelText: type.number == NumberRule.optional ? '${type.label} number (optional)' : '${type.label} number',
                  helperText: type.hint,
                  helperMaxLines: 2,
                  errorText: _errors['number'],
                  counterText: '',
                  suffixIcon: type.id == 'aadhaar'
                      ? IconButton(
                          key: const Key('show-number'),
                          tooltip: hidden ? 'Show' : 'Hide',
                          icon: Icon(hidden ? Icons.visibility_outlined : Icons.visibility_off_outlined),
                          onPressed: () => setState(() => _showNumber = !_showNumber),
                        )
                      : null,
                ),
              ),
            ],
            if (type.expiry) ...[
              const SizedBox(height: 16),
              InkWell(
                key: const Key('field-expiry'),
                onTap: _busy ? null : _pickDate,
                borderRadius: BorderRadius.circular(radiusBlock),
                child: InputDecorator(
                  decoration: InputDecoration(
                    labelText: 'Valid until',
                    errorText: _errors['expiry'],
                    suffixIcon: const Icon(Icons.calendar_today_outlined, size: 20),
                  ),
                  child: Text(
                    _expiry.isEmpty ? 'Choose a date' : formatDay(_expiry),
                    style: TextStyle(fontSize: 16, color: _expiry.isEmpty ? c.muted : c.ink),
                  ),
                ),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 14),
              Text(_error!, key: const Key('upload-error'), style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
            ],
            const SizedBox(height: 24),
            FilledButton(
              key: const Key('upload-submit'),
              onPressed: _busy ? null : _submit,
              child: _busy
                  ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                  : Text(existing == null ? 'Upload' : 'Replace'),
            ),
          ],
        ),
      ),
    );
  }
}
