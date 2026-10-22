import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api.dart';
import '../../core/errors.dart';
import '../../data/profile_repository.dart';
import '../../models/profile.dart';
import '../../theme/app_theme.dart';
import 'form_sheet.dart';

// Every sheet here returns the sentence to show once it saved (null when the
// rider backed out). Names, addresses and relations are taken as typed, in
// any script: nothing below assumes ASCII.

/// A change that waits for Deligro, or was saved straight away.
String _requestedMessage(String what, ChangeOutcome outcome) => outcome == ChangeOutcome.pending
    ? '$what change sent. Waiting for Deligro.'
    : '$what saved.';

String? _blankToNull(String s) {
  final t = s.trim();
  return t.isEmpty ? null : t;
}

final _nameShape = RegExp(r"^[\p{L}\p{M}][\p{L}\p{M} .'-]*$", unicode: true);

/// A person's name in any script: letters, combining marks, spaces, `.`, `'`, `-`.
String? nameProblem(String raw, {int min = 2, int max = 80}) {
  final s = raw.trim().replaceAll(RegExp(r'\s+'), ' ');
  final length = s.runes.length;
  if (length < min) return 'Enter at least $min letters.';
  if (length > max) return 'Keep it under $max letters.';
  if (!_nameShape.hasMatch(s)) return 'Use letters, spaces, . \' or - only.';
  return null;
}

/// `+91 98765-43210` -> `+919876543210`; null when it is not 10 to 13 digits.
String? normalizePhone(String raw) {
  final s = raw.replaceAll(RegExp(r'[\s()-]+'), '');
  return RegExp(r'^\+?\d{10,13}$').hasMatch(s) ? s : null;
}

// ---------- Name ----------

Future<String?> showNameSheet(BuildContext context, ProfileRepository repo, RiderProfile p) async {
  ChangeOutcome? outcome;
  final saved = await showFormSheet(
    context,
    FormSheet(
      title: 'Change your name',
      intro: p.everVerified
          ? 'Deligro has checked your name, so Deligro has to approve a change.'
          : 'Use your name as it is on your driving licence.',
      submitLabel: p.everVerified ? 'Send for approval' : 'Save',
      fields: [
        FieldSpec(
          'name',
          'Full name',
          initial: p.name ?? '',
          capitalization: TextCapitalization.words,
          maxLength: 80,
        ),
      ],
      validate: (v) {
        final problem = nameProblem(v['name']!);
        return problem == null ? const {} : {'name': problem};
      },
      serverFields: const {'fullName': 'name'},
      onSubmit: (v) async {
        outcome = await repo.requestChange('full_name', {'fullName': v['name']!.trim()});
      },
    ),
  );
  return saved ? _requestedMessage('Name', outcome ?? ChangeOutcome.pending) : null;
}

// ---------- Address (saves directly) ----------

Future<String?> showAddressSheet(BuildContext context, ProfileRepository repo, RiderProfile p) async {
  final saved = await showFormSheet(
    context,
    FormSheet(
      title: 'Your address',
      submitLabel: 'Save',
      fields: [
        FieldSpec(
          'line',
          'House, street, area',
          initial: p.address.line ?? '',
          capitalization: TextCapitalization.words,
          maxLength: 200,
          optional: true,
        ),
        FieldSpec(
          'city',
          'City',
          initial: p.address.city ?? '',
          capitalization: TextCapitalization.words,
          maxLength: 80,
          optional: true,
        ),
        FieldSpec(
          'pincode',
          'Pincode',
          initial: p.address.pincode ?? '',
          keyboard: TextInputType.number,
          maxLength: 6,
          optional: true,
          formatters: [FilteringTextInputFormatter.digitsOnly],
        ),
      ],
      validate: (v) => {
        if (v['pincode']!.isNotEmpty && v['pincode']!.length != 6) 'pincode': 'A pincode has 6 digits.',
      },
      serverFields: const {'address.line': 'line', 'address.city': 'city', 'address.pincode': 'pincode'},
      onSubmit: (v) => repo.saveDirect(
        address: {
          'line': _blankToNull(v['line']!),
          'city': _blankToNull(v['city']!),
          'pincode': _blankToNull(v['pincode']!),
        },
      ),
    ),
  );
  return saved ? 'Address saved.' : null;
}

// ---------- Emergency contact (saves directly) ----------

Future<String?> showEmergencySheet(BuildContext context, ProfileRepository repo, RiderProfile p) async {
  final saved = await showFormSheet(
    context,
    FormSheet(
      title: 'Emergency contact',
      intro: 'Someone Deligro can call if something goes wrong on a delivery.',
      submitLabel: 'Save',
      fields: [
        FieldSpec(
          'name',
          'Their name',
          initial: p.emergency.name ?? '',
          capitalization: TextCapitalization.words,
          maxLength: 80,
          optional: true,
        ),
        FieldSpec(
          'relation',
          'Who they are to you',
          initial: p.emergency.relation ?? '',
          capitalization: TextCapitalization.sentences,
          maxLength: 40,
          optional: true,
        ),
        FieldSpec(
          'phone',
          'Their mobile number',
          initial: p.emergency.phone ?? '',
          keyboard: TextInputType.phone,
          maxLength: 16,
          optional: true,
        ),
      ],
      validate: (v) => {
        if (v['name']!.trim().isNotEmpty && nameProblem(v['name']!) != null) 'name': nameProblem(v['name']!)!,
        if (v['phone']!.trim().isNotEmpty && normalizePhone(v['phone']!) == null)
          'phone': 'Enter a phone number with 10 to 13 digits.',
      },
      serverFields: const {'emergency.name': 'name', 'emergency.phone': 'phone', 'emergency.relation': 'relation'},
      onSubmit: (v) => repo.saveDirect(
        emergency: {
          'name': _blankToNull(v['name']!),
          'relation': _blankToNull(v['relation']!),
          'phone': v['phone']!.trim().isEmpty ? null : normalizePhone(v['phone']!),
        },
      ),
    ),
  );
  return saved ? 'Emergency contact saved.' : null;
}

// ---------- Vehicle ----------

final _registration = RegExp(r'^[A-Z0-9-]{6,15}$');
final _licenceNumber = RegExp(r'^[A-Z0-9-]{8,20}$');

String _tidy(String s) => s.replaceAll(RegExp(r'\s+'), '').toUpperCase();

Future<String?> showVehicleSheet(BuildContext context, ProfileRepository repo, RiderProfile p) async {
  ChangeOutcome? outcome;
  final saved = await showFormSheet(
    context,
    FormSheet(
      title: 'Your vehicle',
      intro: p.everVerified
          ? 'Deligro has checked your vehicle, so Deligro has to approve a change.'
          : 'Deligro supplies the EV bike. Choose "My own" only if you ride your own.',
      submitLabel: p.everVerified ? 'Send for approval' : 'Save',
      fields: [
        FieldSpec(
          'type',
          'Type',
          kind: FieldKind.choice,
          initial: p.vehicle.type ?? 'ev_bike',
          options: [for (final e in vehicleTypeLabels.entries) (e.key, e.value)],
        ),
        FieldSpec(
          'owner',
          'Whose is it',
          kind: FieldKind.choice,
          initial: p.vehicle.owner,
          options: const [('deligro', "Deligro's"), ('rider', 'My own')],
        ),
        FieldSpec(
          'registration',
          'Registration number',
          initial: p.vehicle.registration ?? '',
          capitalization: TextCapitalization.characters,
          maxLength: 18,
          optional: true,
        ),
      ],
      validate: (v) => {
        if (v['registration']!.trim().isNotEmpty && !_registration.hasMatch(_tidy(v['registration']!)))
          'registration': 'Use letters, numbers and - (6 to 15 characters).',
      },
      serverFields: const {'registration': 'registration'},
      onSubmit: (v) async {
        outcome = await repo.requestChange('vehicle', {
          'type': v['type'],
          'owner': v['owner'],
          'registration': v['registration']!.trim().isEmpty ? null : _tidy(v['registration']!),
        });
      },
    ),
  );
  return saved ? _requestedMessage('Vehicle', outcome ?? ChangeOutcome.pending) : null;
}

// ---------- Driving licence ----------

/// [today] is the IST day (`YYYY-MM-DD`) from the app's clock.
Future<String?> showLicenceSheet(BuildContext context, ProfileRepository repo, RiderProfile p, {required String today}) async {
  ChangeOutcome? outcome;
  final saved = await showFormSheet(
    context,
    FormSheet(
      title: 'Driving licence',
      intro: p.everVerified
          ? 'Deligro has checked your licence, so Deligro has to approve a change. Upload the new licence in Documents too.'
          : 'Add your licence number and the date it runs out.',
      submitLabel: p.everVerified ? 'Send for approval' : 'Save',
      fields: [
        FieldSpec(
          'number',
          'Licence number',
          initial: p.licence.number ?? '',
          capitalization: TextCapitalization.characters,
          maxLength: 24,
        ),
        FieldSpec('expiresOn', 'Valid until', kind: FieldKind.date, initial: p.licence.expiresOn ?? ''),
      ],
      validate: (v) => {
        if (!_licenceNumber.hasMatch(_tidy(v['number']!))) 'number': 'Use letters, numbers and - (8 to 20 characters).',
        if (v['expiresOn']!.compareTo(today) < 0) 'expiresOn': 'Choose a date that has not passed.',
      },
      serverFields: const {'number': 'number', 'expiresOn': 'expiresOn'},
      onSubmit: (v) async {
        outcome = await repo.requestChange('licence', {
          'number': _tidy(v['number']!),
          'expiresOn': v['expiresOn'],
        });
      },
    ),
  );
  return saved ? _requestedMessage('Licence', outcome ?? ChangeOutcome.pending) : null;
}

// ---------- Phone (the existing OTP flow) ----------

final _mobile = RegExp(r'^[6-9]\d{9}$');
const _codeLength = 6;

/// Changes the login number: a code goes to the NEW number, then
/// `PATCH /api/profile { phone, phoneOtp }`, the same flow as the customer app.
Future<String?> showPhoneSheet(BuildContext context, ProfileRepository repo) async {
  final saved = await showModalBottomSheet<bool>(
    context: context,
    useRootNavigator: true,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => _PhoneSheet(repo: repo),
  );
  return saved == true ? 'Phone number changed.' : null;
}

class _PhoneSheet extends StatefulWidget {
  const _PhoneSheet({required this.repo});
  final ProfileRepository repo;

  @override
  State<_PhoneSheet> createState() => _PhoneSheetState();
}

class _PhoneSheetState extends State<_PhoneSheet> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  bool _sent = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() job, {required VoidCallback onDone}) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await job();
      if (!mounted) return;
      setState(() => _busy = false);
      onDone();
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e.friendly;
        });
      }
    }
  }

  Future<void> _sendCode() async {
    if (!_mobile.hasMatch(_phone.text)) {
      setState(() => _error = friendlyError('invalid_phone'));
      return;
    }
    await _run(() => widget.repo.sendPhoneCode('+91${_phone.text}'), onDone: () => setState(() => _sent = true));
  }

  Future<void> _verify() async {
    if (_code.text.length != _codeLength) {
      setState(() => _error = 'Enter the $_codeLength-digit code.');
      return;
    }
    await _run(
      () => widget.repo.updatePhone('+91${_phone.text}', _code.text),
      onDone: () => Navigator.pop(context, true),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Change your phone number', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 6),
            Text(
              _sent
                  ? 'We sent a code to +91 ${_phone.text}.'
                  : 'This is the number you sign in with. We will send a code to the new number.',
              style: TextStyle(color: c.muted, height: 1.35),
            ),
            const SizedBox(height: 16),
            if (!_sent)
              TextField(
                key: const Key('field-phone'),
                controller: _phone,
                enabled: !_busy,
                keyboardType: TextInputType.number,
                maxLength: 10,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: const InputDecoration(labelText: 'New mobile number', prefixText: '+91  ', counterText: ''),
              )
            else
              TextField(
                key: const Key('field-code'),
                controller: _code,
                enabled: !_busy,
                keyboardType: TextInputType.number,
                maxLength: _codeLength,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: const InputDecoration(labelText: 'Code', counterText: ''),
              ),
            if (_error != null) ...[
              const SizedBox(height: 10),
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
                    onPressed: _busy ? null : (_sent ? _verify : _sendCode),
                    child: _busy
                        ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5))
                        : Text(_sent ? 'Change number' : 'Send code'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Shown above the form in the payout sheets etc.: "Now: Bank account XXXX4521".
class CurrentValueNote extends StatelessWidget {
  const CurrentValueNote(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
      child: Text(text, style: dataStyle(context, size: 14, weight: FontWeight.w600)),
    );
  }
}
