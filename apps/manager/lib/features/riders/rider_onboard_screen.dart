import 'package:cross_file/cross_file.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/manager_me.dart' show Zone;
import '../../models/outcome.dart';
import '../../models/rider.dart';
import '../../state/providers.dart';
import '../../state/rider_onboard_draft.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/document_picker.dart';
import '../vendors/vendor_tabs.dart' show FactRow, InfoSection;
import 'rider_tabs.dart' show riderDocumentFileProblem;

const _uuid = Uuid();

final _tenDigits = RegExp(r'^[6-9]\d{9}$');
final _sixDigits = RegExp(r'^\d{6}$');
final _email = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

const _steps = ['Rider', 'Vehicle & licence', 'Address & emergency', 'Documents', 'Review'];

/// Onboard a rider (§5.2, `manager.riders.onboard`): account, vehicle and
/// licence, address and emergency contact, documents, then review and
/// submit. The draft is kept on the phone between steps (never the
/// password). One `clientActionId` per submission, so a retry after a fault
/// can never create a second account. A generated password is shown once.
/// Documents upload one by one afterwards, each with its own Retry.
class RiderOnboardScreen extends ConsumerStatefulWidget {
  const RiderOnboardScreen({super.key});

  @override
  ConsumerState<RiderOnboardScreen> createState() => _RiderOnboardScreenState();
}

enum _Upload { waiting, sending, done, failed }

class _RiderOnboardScreenState extends ConsumerState<RiderOnboardScreen> {
  int _step = 0;
  final _c = <String, TextEditingController>{};

  /// Server complaints by field, cleared when the field is edited.
  final _serverErrors = <String, String>{};

  /// Files chosen per document type (kept in memory only).
  final _files = <RiderDocType, XFile>{};
  final _expiries = <RiderDocType, DateTime>{};

  String? _clientActionId;
  bool _submitting = false;
  RiderOnboardResult? _result;
  String? _submitError;

  final _uploads = <RiderDocType, _Upload>{};
  final _uploadIds = <RiderDocType, String>{};
  final _uploadErrors = <RiderDocType, String>{};

  RiderOnboardDraft get _d => ref.read(riderOnboardDraftProvider);

  TextEditingController _ctl(String key, String initial) => _c.putIfAbsent(key, () => TextEditingController(text: initial));

  @override
  void dispose() {
    for (final c in _c.values) {
      c.dispose();
    }
    super.dispose();
  }

  void _set(RiderOnboardDraft next, [String? field]) {
    if (field != null) _serverErrors.remove(field);
    ref.read(riderOnboardDraftProvider.notifier).update(next);
    setState(() {});
  }

  /// The zone to use: the draft's, or the only one this manager has.
  String? _zoneId(List<({String id, String name})> zones) =>
      _d.zoneId ?? (zones.length == 1 ? zones.single.id : null);

  // ── validation ──────────────────────────────────────────────────────────

  Map<String, String> _errors(RiderOnboardDraft d, int step, List<({String id, String name})> zones) {
    final e = <String, String>{};
    String t(String s) => s.trim();
    switch (step) {
      case 0:
        if (t(d.mobile).isNotEmpty && !_tenDigits.hasMatch(t(d.mobile))) e['mobile'] = 'Enter the 10-digit mobile number.';
        if (t(d.email).isNotEmpty && !_email.hasMatch(t(d.email))) e['email'] = "That email doesn't look right.";
        if (d.password.isNotEmpty && d.password.length < 8) {
          e['password'] = 'At least 8 characters, or leave it empty to generate one.';
        }
      case 2:
        if (t(d.pincode).isNotEmpty && !_sixDigits.hasMatch(t(d.pincode))) e['pincode'] = 'A pincode has 6 digits.';
        if (t(d.emergencyPhone).isNotEmpty && !_tenDigits.hasMatch(t(d.emergencyPhone))) {
          e['emergencyPhone'] = 'Enter the 10-digit mobile number.';
        }
    }
    for (final MapEntry(:key, :value) in _serverErrors.entries) {
      if (_stepOf(key) == step) e[key] = value;
    }
    return e;
  }

  bool _complete(RiderOnboardDraft d, int step, List<({String id, String name})> zones) {
    if (_errors(d, step, zones).isNotEmpty) return false;
    return switch (step) {
      0 => d.fullName.trim().length >= 2 && _tenDigits.hasMatch(d.mobile.trim()) && _zoneId(zones) != null,
      _ => true,
    };
  }

  int _stepOf(String field) => switch (field) {
        'fullName' || 'mobile' || 'email' || 'password' || 'zoneId' => 0,
        'vehicleType' || 'vehicleOwner' || 'vehicleRegistration' || 'licenceNumber' || 'licenceExpiresOn' => 1,
        'addressLine' || 'pincode' || 'emergencyName' || 'emergencyPhone' || 'emergencyRelation' => 2,
        _ => 0,
      };

  List<RiderDocType> get _docTypes => [
        ...RiderDocType.required,
        RiderDocType.pan,
        if (_d.ownVehicle) ...RiderDocType.ownVehicle,
      ];

  // ── submit ──────────────────────────────────────────────────────────────

  Future<void> _submit(List<({String id, String name})> zones) async {
    // A tap that lands after the rider was created is not a second rider.
    if (_submitting || _result != null) return;
    setState(() {
      _submitting = true;
      _submitError = null;
    });
    final id = _clientActionId ??= _uuid.v4();
    final draft = _d.copyWith(zoneId: _zoneId(zones));
    try {
      final out = await ref.read(ridersRepoProvider).onboard(draft, id);
      if (!mounted) return;
      switch (out) {
        case Applied(:final value?):
          ref.read(riderOnboardDraftProvider.notifier).clear();
          setState(() => _result = value);
          await _uploadAll();
        case Applied():
          setState(() => _submitError = 'The rider was added, but the answer was incomplete. Check the Riders list.');
        case Refused():
          // The draft has to change before it can succeed: a fresh id next time.
          _clientActionId = null;
          _refused(out);
      }
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      // Same id on the next tap: a retry is the same submission.
      if (mounted) setState(() => _submitError = '${e.friendly} Tap Submit to try again.');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  void _refused(Refused<RiderOnboardResult> r) {
    setState(() {
      switch (r.code) {
        case 'phone_taken':
          _serverErrors['mobile'] = 'This mobile number already has an account.';
          _step = 0;
        case 'email_taken':
          _serverErrors['email'] = 'This email already has an account.';
          _step = 0;
        case 'not_found':
          _serverErrors['zoneId'] = "That zone isn't one of yours any more. Pick another.";
          _step = 0;
        case 'bad_request' when r.field != null:
          _serverErrors[r.field!] = "The server didn't accept this. Check it and try again.";
          _step = _stepOf(r.field!);
        case 'stale':
          _submitError = 'That attempt was already used. Tap Submit again to start a fresh one.';
        case 'permission_denied' || 'forbidden':
          _submitError = "You don't have permission to add riders. Ask an admin.";
        default:
          _submitError = "That didn't go through (${r.code}).";
      }
    });
  }

  Future<void> _uploadAll() async {
    for (final t in _files.keys.toList()) {
      _uploads[t] = _Upload.waiting;
      _uploadIds[t] = _uuid.v4();
    }
    setState(() {});
    for (final t in _files.keys.toList()) {
      await _upload(t);
    }
  }

  Future<void> _upload(RiderDocType t) async {
    final r = _result;
    final file = _files[t];
    if (r == null || file == null) return;
    setState(() {
      _uploads[t] = _Upload.sending;
      _uploadErrors.remove(t);
    });
    try {
      final out = await ref.read(ridersRepoProvider).upload(
            r.riderId,
            type: t,
            file: file,
            expiresOn: t == RiderDocType.drivingLicence ? _d.licenceExpiresOn ?? _expiries[t] : _expiries[t],
            clientActionId: _uploadIds[t]!,
          );
      if (!mounted) return;
      setState(() {
        switch (out) {
          case Applied():
            _uploads[t] = _Upload.done;
          case Refused(:final code):
            _uploads[t] = _Upload.failed;
            _uploadErrors[t] = switch (code) {
              'bad_type' => 'Use a JPEG, PNG or PDF file.',
              'too_large' => 'That file is over 10 MB.',
              'expiry_required' => 'Needs an expiry date — add it from the rider page.',
              _ => "Couldn't upload ($code).",
            };
        }
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _uploads[t] = _Upload.failed;
          _uploadErrors[t] = e.friendly;
        });
      }
    }
  }

  Future<void> _pick(RiderDocType t) async {
    final f = await ref.read(documentPickerProvider)(context);
    if (f == null || !mounted) return;
    final problem = await riderDocumentFileProblem(f);
    if (problem != null) {
      if (mounted) showSnack(context, problem);
      return;
    }
    if (t.needsExpiry && t != RiderDocType.drivingLicence && mounted) {
      final today = istToday();
      final d = await showDatePicker(
        context: context,
        helpText: '${t.label} expires on',
        initialDate: today.add(const Duration(days: 365)),
        firstDate: today,
        lastDate: DateTime(today.year + 20),
      );
      if (d != null) _expiries[t] = d;
    }
    if (mounted) setState(() => _files[t] = f);
  }

  // ── build ───────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    ref.watch(riderOnboardDraftProvider);
    final zones = [for (final Zone z in me?.zones.zones ?? const <Zone>[]) (id: z.id, name: z.name)];
    final done = _result != null;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Text(done ? 'Rider added' : 'Add a rider'),
        backgroundColor: c.bg,
        actions: [
          if (!done)
            TextButton(
              key: const Key('onboard-discard'),
              onPressed: () async {
                final go = await showDialog<bool>(
                  context: context,
                  builder: (ctx) => AlertDialog(
                    title: const Text('Discard this draft?'),
                    actions: [
                      TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Keep')),
                      FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Discard')),
                    ],
                  ),
                );
                if (go ?? false) {
                  ref.read(riderOnboardDraftProvider.notifier).clear();
                  for (final ctl in _c.values) {
                    ctl.clear();
                  }
                  setState(() {
                    _files.clear();
                    _step = 0;
                  });
                }
              },
              child: const Text('Discard'),
            ),
        ],
      ),
      body: SafeArea(child: done ? _doneView(c) : _form(c, zones)),
    );
  }

  Widget _form(AppColors c, List<({String id, String name})> zones) {
    final d = _d;
    final errors = _errors(d, _step, zones);
    final ok = _complete(d, _step, zones);
    final last = _step == _steps.length - 1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
          child: Text('Step ${_step + 1} of ${_steps.length} · ${_steps[_step]}',
              style: TextStyle(color: c.muted, fontWeight: FontWeight.w600)),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: LinearProgressIndicator(value: (_step + 1) / _steps.length, backgroundColor: c.surface2, color: c.accent),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
            children: switch (_step) {
              0 => _stepRider(d, errors, zones),
              1 => _stepVehicle(d, errors),
              2 => _stepAddress(d, errors),
              3 => _stepDocuments(c),
              _ => _stepReview(c, d, zones),
            },
          ),
        ),
        if (_submitError != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(_submitError!, style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
          child: Row(
            children: [
              if (_step > 0)
                OutlinedButton(
                  key: const Key('onboard-back'),
                  onPressed: _submitting ? null : () => setState(() => _step--),
                  child: const Text('Back'),
                ),
              const Spacer(),
              if (last)
                FilledButton(
                  key: const Key('onboard-submit'),
                  onPressed: _submitting ? null : () => _submit(zones),
                  child: Text(_submitting ? 'Adding…' : 'Submit'),
                )
              else
                FilledButton(
                  key: const Key('onboard-next'),
                  onPressed: ok ? () => setState(() => _step++) : null,
                  child: const Text('Next'),
                ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _field(
    String key,
    String label,
    String value,
    void Function(String v) onChanged, {
    String? error,
    TextInputType? keyboard,
    List<TextInputFormatter>? formatters,
    bool obscure = false,
    String? helper,
  }) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: TextField(
          key: Key('rider-$key'),
          controller: _ctl(key, value),
          keyboardType: keyboard,
          inputFormatters: formatters,
          obscureText: obscure,
          decoration: InputDecoration(labelText: label, errorText: error, helperText: helper),
          onChanged: onChanged,
        ),
      );

  List<Widget> _stepRider(RiderOnboardDraft d, Map<String, String> e, List<({String id, String name})> zones) {
    final zone = _zoneId(zones);
    return [
      _field('name', 'Full name', d.fullName, (v) => _set(d.copyWith(fullName: v), 'fullName')),
      _field(
        'mobile',
        'Mobile number',
        d.mobile,
        (v) => _set(_d.copyWith(mobile: v.trim()), 'mobile'),
        error: e['mobile'],
        keyboard: TextInputType.phone,
        formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
      ),
      _field('email', 'Email (optional)', d.email, (v) => _set(_d.copyWith(email: v.trim()), 'email'),
          error: e['email'], keyboard: TextInputType.emailAddress),
      _field(
        'password',
        'Password (optional)',
        d.password,
        (v) => _set(_d.copyWith(password: v), 'password'),
        error: e['password'],
        obscure: true,
        helper: 'Leave empty and one is generated and shown once.',
      ),
      DropdownButtonFormField<String>(
        key: const Key('rider-zone'),
        initialValue: zone,
        decoration: InputDecoration(labelText: 'Zone', errorText: e['zoneId']),
        items: [for (final z in zones) DropdownMenuItem(value: z.id, child: Text(z.name))],
        onChanged: (v) => _set(_d.copyWith(zoneId: v), 'zoneId'),
      ),
    ];
  }

  List<Widget> _stepVehicle(RiderOnboardDraft d, Map<String, String> e) => [
        Text('Whose vehicle?', style: TextStyle(fontWeight: FontWeight.w700, color: context.colors.ink)),
        const SizedBox(height: 8),
        SegmentedButton<String>(
          key: const Key('rider-owner'),
          segments: const [
            ButtonSegment(value: 'deligro', label: Text('Deligro')),
            ButtonSegment(value: 'rider', label: Text('The rider')),
          ],
          selected: {d.vehicleOwner},
          onSelectionChanged: (s) => _set(_d.copyWith(vehicleOwner: s.first), 'vehicleOwner'),
        ),
        const SizedBox(height: 14),
        DropdownButtonFormField<VehicleType>(
          key: const Key('rider-vehicle-type'),
          initialValue: d.vehicleType,
          decoration: const InputDecoration(labelText: 'Vehicle'),
          items: [for (final v in VehicleType.choices) DropdownMenuItem(value: v, child: Text(v.label))],
          onChanged: (v) => _set(_d.copyWith(vehicleType: v), 'vehicleType'),
        ),
        const SizedBox(height: 12),
        _field('registration', 'Registration number (optional)', d.vehicleRegistration,
            (v) => _set(_d.copyWith(vehicleRegistration: v.toUpperCase()), 'vehicleRegistration'),
            error: e['vehicleRegistration']),
        _field('licence', 'Driving licence number (optional)', d.licenceNumber,
            (v) => _set(_d.copyWith(licenceNumber: v.toUpperCase()), 'licenceNumber'),
            error: e['licenceNumber']),
        Row(
          children: [
            Expanded(
              child: Text(
                d.licenceExpiresOn == null ? 'Licence expiry not set' : 'Licence expires ${ymd(d.licenceExpiresOn!)}',
                style: TextStyle(color: e['licenceExpiresOn'] != null ? context.colors.deal : context.colors.ink),
              ),
            ),
            TextButton(
              key: const Key('rider-licence-expiry'),
              onPressed: () async {
                final today = istToday();
                final picked = await showDatePicker(
                  context: context,
                  initialDate: d.licenceExpiresOn ?? today.add(const Duration(days: 365)),
                  firstDate: today,
                  lastDate: DateTime(today.year + 25),
                );
                if (picked != null) _set(_d.copyWith(licenceExpiresOn: picked), 'licenceExpiresOn');
              },
              child: const Text('Set'),
            ),
          ],
        ),
      ];

  List<Widget> _stepAddress(RiderOnboardDraft d, Map<String, String> e) => [
        _field('address', 'Address (optional)', d.addressLine, (v) => _set(_d.copyWith(addressLine: v), 'addressLine'),
            error: e['addressLine']),
        _field(
          'pincode',
          'Pincode (optional)',
          d.pincode,
          (v) => _set(_d.copyWith(pincode: v.trim()), 'pincode'),
          error: e['pincode'],
          keyboard: TextInputType.number,
          formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
        ),
        InfoSection(title: 'Emergency contact', children: [
          _field('em-name', 'Name (optional)', d.emergencyName, (v) => _set(_d.copyWith(emergencyName: v), 'emergencyName')),
          _field(
            'em-phone',
            'Phone (optional)',
            d.emergencyPhone,
            (v) => _set(_d.copyWith(emergencyPhone: v.trim()), 'emergencyPhone'),
            error: e['emergencyPhone'],
            keyboard: TextInputType.phone,
            formatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(10)],
          ),
          _field('em-relation', 'Relation (optional)', d.emergencyRelation,
              (v) => _set(_d.copyWith(emergencyRelation: v), 'emergencyRelation')),
        ]),
      ];

  List<Widget> _stepDocuments(AppColors c) => [
        Text(
          'Aadhaar, driving licence and a photo are needed before the rider can be verified. '
          'You can add them now or later from the rider page.',
          style: TextStyle(color: c.muted, fontSize: 13.5),
        ),
        const SizedBox(height: 10),
        for (final t in _docTypes)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        RiderDocType.required.contains(t) ? t.label : '${t.label} (optional)',
                        style: TextStyle(fontWeight: FontWeight.w700, color: c.ink),
                      ),
                      Text(
                        _files[t]?.name ?? 'Not added',
                        style: TextStyle(fontSize: 12.5, color: _files[t] == null ? c.muted : c.green),
                      ),
                    ],
                  ),
                ),
                OutlinedButton(
                  key: Key('doc-pick-${t.wire}'),
                  onPressed: () => _pick(t),
                  child: Text(_files[t] == null ? 'Add' : 'Change'),
                ),
              ],
            ),
          ),
      ];

  List<Widget> _stepReview(AppColors c, RiderOnboardDraft d, List<({String id, String name})> zones) {
    final zoneName = zones.where((z) => z.id == _zoneId(zones)).map((z) => z.name).firstOrNull ?? '—';
    String or(String s) => s.trim().isEmpty ? '—' : s.trim();
    return [
      InfoSection(title: 'Rider', children: [
        FactRow('Name', d.fullName.trim()),
        FactRow('Mobile', d.mobile, mono: true),
        FactRow('Email', or(d.email)),
        FactRow('Password', d.password.isEmpty ? 'Generated and shown once' : 'Set by you'),
        FactRow('Zone', zoneName),
      ]),
      InfoSection(title: 'Vehicle and licence', children: [
        FactRow('Owned by', d.ownVehicle ? 'The rider' : 'Deligro'),
        FactRow('Vehicle', d.vehicleType.label),
        FactRow('Registration', or(d.vehicleRegistration), mono: true),
        FactRow('Licence', or(d.licenceNumber), mono: true),
        FactRow('Licence expires', d.licenceExpiresOn == null ? '—' : ymd(d.licenceExpiresOn!), mono: true),
      ]),
      InfoSection(title: 'Address and emergency', children: [
        FactRow('Address', or([d.addressLine.trim(), d.pincode.trim()].where((s) => s.isNotEmpty).join(', '))),
        FactRow('Emergency contact', or([d.emergencyName, d.emergencyRelation, d.emergencyPhone]
            .map((s) => s.trim())
            .where((s) => s.isNotEmpty)
            .join(', '))),
      ]),
      InfoSection(title: 'Documents', children: [
        Text(
          _files.isEmpty ? 'None added — they can be uploaded later.' : _files.keys.map((t) => t.label).join(', '),
          style: TextStyle(color: c.ink),
        ),
      ]),
    ];
  }

  Widget _doneView(AppColors c) {
    final r = _result!;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      children: [
        Text(
          r.riderCode == null ? 'The rider can sign in now.' : '${r.riderCode} can sign in now.',
          style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink),
        ),
        const SizedBox(height: 12),
        if (r.password != null)
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: c.accentSoft,
              borderRadius: BorderRadius.circular(radiusBlock),
              border: Border.all(color: c.accent),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                FactRow('Mobile', r.mobile ?? '—', mono: true),
                FactRow('Password', r.password!, mono: true),
                const SizedBox(height: 6),
                Text('This password will not be shown again.',
                    style: TextStyle(color: c.deal, fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                FilledButton.icon(
                  key: const Key('cred-copy'),
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: 'Mobile: ${r.mobile ?? ''}\nPassword: ${r.password}'));
                    if (mounted) showSnack(context, 'Copied. Share it with the rider privately.');
                  },
                  icon: const Icon(Icons.copy, size: 18),
                  label: const Text('Copy'),
                ),
              ],
            ),
          )
        else
          Text(
            'They sign in with the mobile number and the password you set. '
            'If you did not set one, the generated password was shown once when the rider was created.',
            style: TextStyle(color: c.muted),
          ),
        if (_uploads.isNotEmpty)
          InfoSection(title: 'Documents', children: [
            for (final t in _uploads.keys)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(t.label, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
                          Text(
                            switch (_uploads[t]!) {
                              _Upload.waiting => 'Waiting…',
                              _Upload.sending => 'Uploading…',
                              _Upload.done => 'Uploaded',
                              _Upload.failed => _uploadErrors[t] ?? 'Upload failed',
                            },
                            style: TextStyle(
                              fontSize: 12.5,
                              color: switch (_uploads[t]!) {
                                _Upload.done => c.green,
                                _Upload.failed => c.deal,
                                _ => c.muted,
                              },
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (_uploads[t] == _Upload.sending)
                      const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
                    if (_uploads[t] == _Upload.failed)
                      TextButton(
                        key: Key('upload-retry-${t.wire}'),
                        onPressed: () => _upload(t),
                        child: const Text('Retry'),
                      ),
                  ],
                ),
              ),
          ]),
        const SizedBox(height: 20),
        FilledButton(
          key: const Key('onboard-open'),
          onPressed: () => GoRouter.maybeOf(context)?.pushReplacement('/more/riders/${r.riderId}'),
          child: const Text('Open the rider'),
        ),
      ],
    );
  }
}
