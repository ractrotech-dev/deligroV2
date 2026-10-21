import 'package:cross_file/cross_file.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';
import 'package:uuid/uuid.dart';

import '../../../core/api.dart';
import '../../../models/manager_me.dart';
import '../../../models/outcome.dart';
import '../../../models/vendors.dart';
import '../../../state/onboard_draft.dart';
import '../../../state/providers.dart';
import '../../../state/session.dart';
import '../../../theme/app_theme.dart';
import '../../../widgets/async_view.dart';
import '../../../widgets/document_picker.dart';
import '../../orders/reason_dialog.dart' show confirm;
import 'map_pin_picker.dart';
import 'onboard_steps.dart';

/// Onboard a vendor (§4.2): Shop → Owner → Location → Hours → Documents →
/// Review. The shop is created `pending`; approval is a separate decision.
/// The draft is kept on the phone (without the password) until submitted or
/// discarded, so a call or a dead battery does not lose it.
class OnboardFlow extends ConsumerStatefulWidget {
  const OnboardFlow({super.key});

  @override
  ConsumerState<OnboardFlow> createState() => _OnboardFlowState();
}

const _steps = ['Shop', 'Owner', 'Location', 'Hours', 'Documents', 'Review'];
const _weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

class _OnboardFlowState extends ConsumerState<OnboardFlow> {
  int _step = 0;
  bool _submitting = false;
  bool _locating = false;

  /// One id per submission attempt of this form; a retry after a network
  /// fault reuses it, a corrected form after a refusal gets a new one.
  String _cid = const Uuid().v4();

  final Map<String, String> _serverErrors = {};
  final Map<DocType, XFile> _docs = {};
  OnboardResult? _result;

  late final Map<String, TextEditingController> _text = {
    for (final k in [
      'shopName',
      'category',
      'description',
      'ownerName',
      'mobile',
      'email',
      'password',
      'address',
      'landmark',
      'pincode',
      'fssaiNumber',
    ])
      k: TextEditingController(text: _initial(k)),
  };

  String _initial(String k) {
    final d = ref.read(onboardDraftProvider);
    return switch (k) {
          'shopName' => d.shopName,
          'category' => d.category,
          'description' => d.description,
          'ownerName' => d.ownerName,
          'mobile' => d.mobile,
          'email' => d.email,
          'address' => d.address,
          'landmark' => d.landmark,
          'pincode' => d.pincode,
          'fssaiNumber' => d.fssaiNumber,
          _ => null,
        } ??
        '';
  }

  @override
  void dispose() {
    for (final c in _text.values) {
      c.dispose();
    }
    super.dispose();
  }

  OnboardDraft get _draft => ref.read(onboardDraftProvider);
  void _update(OnboardDraft d) => ref.read(onboardDraftProvider.notifier).update(d);

  /// The draft with the zone filled in when the manager has exactly one.
  OnboardDraft _effective(OnboardDraft d, ManagerMe? me) {
    if (d.zoneId != null || me == null) return d;
    final zones = me.zones.zones;
    return zones.length == 1 ? d.copyWith(zoneId: zones.single.id) : d;
  }

  String? _stepError(OnboardDraft d) => switch (_step) {
        0 => d.shopError,
        1 => d.ownerError,
        2 => d.locationError,
        3 => d.hoursError,
        _ => null,
      };

  void _field(String key, String value) {
    _serverErrors.remove(key);
    final d = _draft;
    _update(switch (key) {
      'shopName' => d.copyWith(shopName: value),
      'category' => d.copyWith(category: value),
      'description' => d.copyWith(description: value),
      'ownerName' => d.copyWith(ownerName: value),
      'mobile' => d.copyWith(mobile: value),
      'email' => d.copyWith(email: value),
      'password' => d.copyWith(password: value),
      'address' => d.copyWith(address: value),
      'landmark' => d.copyWith(landmark: value),
      'pincode' => d.copyWith(pincode: value),
      'fssaiNumber' => d.copyWith(fssaiNumber: value),
      _ => d,
    });
    setState(() {});
  }

  Future<void> _useLocation() async {
    setState(() => _locating = true);
    final at = await ref.read(currentLocationProvider)();
    if (!mounted) return;
    setState(() => _locating = false);
    if (at == null) {
      showSnack(context, "Couldn't get this phone's location. Tap the map to pin the shop.");
      return;
    }
    _update(_draft.copyWith(lat: at.latitude, lng: at.longitude));
  }

  Future<void> _pickTime(bool opening) async {
    final d = _draft;
    final current = opening ? d.openingTime : d.closingTime;
    final parts = (current ?? (opening ? '09:00' : '22:00')).split(':');
    final t = await showTimePicker(
      context: context,
      initialTime: TimeOfDay(hour: int.parse(parts[0]), minute: int.parse(parts[1])),
    );
    if (t == null) return;
    final s = '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
    _update(opening ? d.copyWith(openingTime: s) : d.copyWith(closingTime: s));
  }

  Future<void> _addDoc(DocType type) async {
    final f = await ref.read(documentPickerProvider)(context);
    if (f == null || !mounted) return;
    final problem = await documentFileProblem(f);
    if (problem != null) {
      if (mounted) showSnack(context, problem);
      return;
    }
    setState(() => _docs[type] = f);
  }

  Future<void> _submit(ManagerMe? me) async {
    if (_submitting || _result != null) return;
    setState(() => _submitting = true);
    final d = _effective(_draft, me);
    final Outcome<OnboardResult> out;
    try {
      out = await ref.read(vendorsRepoProvider).onboard(d, _cid);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _submitting = false);
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text(e.friendly),
          action: SnackBarAction(label: 'Retry', onPressed: () => _submit(me)),
        ));
      return;
    }
    if (!mounted) return;
    switch (out) {
      case Applied(:final value?):
        ref.read(onboardDraftProvider.notifier).clear();
        setState(() {
          _submitting = false;
          _result = value;
        });
      case Applied():
        setState(() => _submitting = false);
        showSnack(context, 'The vendor was created. Find it in the Vendors list.');
      case Refused(:final code, :final field):
        // A corrected form is a new decision.
        _cid = const Uuid().v4();
        final (step, key, words) = switch (code) {
          'phone_taken' => (1, 'mobile', 'This mobile number already has an account'),
          'email_taken' => (1, 'email', 'This email already has an account'),
          'not_found' => (0, 'zone', "That zone isn't one of yours"),
          _ => (_stepForField(field), field ?? '', _badRequestWords(code, field)),
        };
        setState(() {
          _submitting = false;
          _serverErrors[key] = words;
          _step = step;
        });
        if (key.isEmpty || step == 5) showSnack(context, words);
    }
  }

  int _stepForField(String? field) => switch (field) {
        'zoneId' || 'shopName' || 'category' || 'description' || 'fssaiNumber' => 0,
        'ownerName' || 'mobile' || 'email' || 'password' => 1,
        'address' || 'landmark' || 'pincode' || 'lat' || 'lng' => 2,
        'openingTime' || 'closingTime' || 'weeklyOff' || 'deliveryAvailable' || 'selfPickup' => 3,
        _ => 5,
      };

  String _badRequestWords(String code, String? field) => switch (code) {
        'permission_denied' || 'forbidden' => "You don't have permission to onboard vendors.",
        'rate_limited' => 'Too many tries. Wait a moment and try again.',
        _ => field == null ? "That didn't go through ($code)." : 'Check this field.',
      };

  Future<void> _discard() async {
    final ok = await confirm(
      context,
      title: 'Discard this draft?',
      message: 'Everything typed so far is cleared from this phone.',
      yes: 'Discard',
    );
    if (!ok || !mounted) return;
    ref.read(onboardDraftProvider.notifier).clear();
    for (final c in _text.values) {
      c.clear();
    }
    setState(() {
      _docs.clear();
      _step = 0;
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final d = _effective(ref.watch(onboardDraftProvider), me);

    if (_result != null) {
      return Scaffold(
        backgroundColor: c.bg,
        appBar: AppBar(title: const Text('Vendor added'), backgroundColor: c.bg),
        body: OnboardDone(result: _result!, shopName: d.shopName.isEmpty ? _text['shopName']!.text : d.shopName, docs: _docs),
      );
    }

    final err = _stepError(d);
    final last = _step == _steps.length - 1;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Add a vendor'),
        backgroundColor: c.bg,
        actions: [TextButton(onPressed: _discard, child: const Text('Discard'))],
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          StepDots(steps: _steps, current: _step),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              children: switch (_step) {
                0 => _shop(d, me),
                1 => _owner(d),
                2 => _location(d),
                3 => _hours(d),
                4 => _documents(),
                _ => [OnboardReview(draft: d, zoneName: _zoneName(me, d.zoneId), docs: _docs.keys.toList())],
              },
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
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
                    FilledButton.icon(
                      key: const Key('onboard-submit'),
                      onPressed: _submitting ? null : () => _submit(me),
                      icon: _submitting
                          ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.check),
                      label: Text(_submitting ? 'Adding…' : 'Add vendor'),
                    )
                  else
                    FilledButton(
                      key: const Key('onboard-next'),
                      onPressed: err == null
                          ? () {
                              if (_step == 0 && _draft.zoneId == null && d.zoneId != null) {
                                _update(_draft.copyWith(zoneId: d.zoneId));
                              }
                              setState(() => _step++);
                            }
                          : null,
                      child: const Text('Next'),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  String? _zoneName(ManagerMe? me, String? id) {
    if (me == null || id == null) return null;
    for (final z in me.zones.zones) {
      if (z.id == id) return '${z.cityName} · ${z.name}';
    }
    return null;
  }

  Widget _input(
    String key,
    String label, {
    String? hint,
    String? error,
    TextInputType? type,
    bool obscure = false,
    int lines = 1,
    String? helper,
  }) {
    final shown = _serverErrors[key] ?? error;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextField(
        key: Key('onboard-${_kebab(key)}'),
        controller: _text[key],
        keyboardType: type,
        obscureText: obscure,
        minLines: lines,
        maxLines: lines,
        onChanged: (v) => _field(key, v),
        textCapitalization: type == null ? TextCapitalization.words : TextCapitalization.none,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          helperText: helper,
          errorText: shown,
          border: const OutlineInputBorder(),
        ),
      ),
    );
  }

  static String _kebab(String camel) =>
      camel.replaceAllMapped(RegExp('[A-Z]'), (m) => '-${m[0]!.toLowerCase()}').replaceAll('fssai-number', 'fssai');

  List<Widget> _shop(OnboardDraft d, ManagerMe? me) {
    final zones = me?.zones.zones ?? const [];
    return [
      StepTitle('The shop', 'What customers will see.'),
      if (zones.length > 1)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: DropdownButtonFormField<String>(
            key: const Key('onboard-zone'),
            initialValue: d.zoneId,
            decoration: InputDecoration(labelText: 'Zone', border: const OutlineInputBorder(), errorText: _serverErrors['zone']),
            items: [for (final z in zones) DropdownMenuItem(value: z.id, child: Text('${z.cityName} · ${z.name}'))],
            onChanged: (v) => _update(_draft.copyWith(zoneId: v)),
          ),
        )
      else if (zones.length == 1)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Row(
            children: [
              Text('Zone  ', style: TextStyle(color: context.colors.muted)),
              Text(zones.single.name, style: TextStyle(fontWeight: FontWeight.w700, color: context.colors.ink)),
            ],
          ),
        ),
      _input('shopName', 'Shop name', error: d.shopName.isNotEmpty && d.shopName.trim().length < 2 ? 'Enter the shop name' : null),
      _input('category', 'Category', hint: 'Restaurant, Cafe, Sweets…'),
      _input('description', 'Description', lines: 3),
      _input('fssaiNumber', 'FSSAI licence number', type: TextInputType.number, helper: 'Optional now; needed before approval'),
    ];
  }

  List<Widget> _owner(OnboardDraft d) => [
        StepTitle('The owner', 'They sign in to the Partner app with this mobile or email.'),
        _input('ownerName', "Owner's name"),
        _input('mobile', 'Mobile number',
            type: TextInputType.phone, hint: '10 digits', error: d.mobile.isEmpty ? null : d.mobileError),
        _input('email', 'Email', type: TextInputType.emailAddress, error: d.email.isEmpty ? null : d.emailError),
        _input('password', 'Password (optional)',
            obscure: true,
            type: TextInputType.visiblePassword,
            error: d.passwordError,
            helper: 'Leave empty and Deligro makes one, shown once after adding'),
      ];

  List<Widget> _location(OnboardDraft d) => [
        StepTitle('Where the shop is', 'Riders are sent to this pin. Approval needs it.'),
        _input('address', 'Address', lines: 2),
        _input('landmark', 'Landmark'),
        _input('pincode', 'Pincode', type: TextInputType.number, error: d.locationError == 'Pincode is 6 digits' ? d.locationError : null),
        Row(
          children: [
            Expanded(
              child: Text(
                d.lat == null ? 'Not pinned yet — tap the map.' : 'Pinned at ${d.lat!.toStringAsFixed(5)}, ${d.lng!.toStringAsFixed(5)}',
                style: TextStyle(color: d.lat == null ? context.colors.deal : context.colors.muted, fontSize: 13),
              ),
            ),
            TextButton.icon(
              key: const Key('onboard-use-location'),
              onPressed: _locating ? null : _useLocation,
              icon: _locating
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.my_location, size: 18),
              label: const Text('Use my location'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        MapPinPicker(
          pin: d.lat == null ? null : LatLng(d.lat!, d.lng!),
          onPin: (at) => _update(_draft.copyWith(lat: at.latitude, lng: at.longitude)),
        ),
      ];

  List<Widget> _hours(OnboardDraft d) {
    final c = context.colors;
    String day(String w) => '${w[0].toUpperCase()}${w.substring(1, 3)}';
    return [
      StepTitle('Hours', 'The shop can change these later in the Partner app.'),
      Row(
        children: [
          Expanded(
            child: OutlinedButton.icon(
              key: const Key('onboard-opening'),
              onPressed: () => _pickTime(true),
              icon: const Icon(Icons.wb_sunny_outlined, size: 18),
              label: Text(d.openingTime == null ? 'Opens at' : 'Opens ${d.openingTime}'),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: OutlinedButton.icon(
              key: const Key('onboard-closing'),
              onPressed: () => _pickTime(false),
              icon: const Icon(Icons.nightlight_outlined, size: 18),
              label: Text(d.closingTime == null ? 'Closes at' : 'Closes ${d.closingTime}'),
            ),
          ),
        ],
      ),
      if (d.hoursError != null)
        Padding(padding: const EdgeInsets.only(top: 6), child: Text(d.hoursError!, style: TextStyle(color: c.deal, fontSize: 12.5))),
      const SizedBox(height: 16),
      Text('Weekly off', style: Theme.of(context).textTheme.titleSmall),
      const SizedBox(height: 8),
      Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final w in _weekdays)
            FilterChip(
              key: Key('onboard-off-$w'),
              label: Text(day(w)),
              selected: d.weeklyOff.contains(w),
              onSelected: (on) => _update(_draft.copyWith(
                weeklyOff: on ? [..._draft.weeklyOff, w] : _draft.weeklyOff.where((x) => x != w).toList(),
              )),
            ),
        ],
      ),
      const SizedBox(height: 12),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Delivery'),
        value: d.deliveryAvailable,
        onChanged: (v) => _update(_draft.copyWith(deliveryAvailable: v)),
      ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Self pickup'),
        value: d.selfPickup,
        onChanged: (v) => _update(_draft.copyWith(selfPickup: v)),
      ),
    ];
  }

  List<Widget> _documents() {
    final c = context.colors;
    return [
      StepTitle('Documents', 'Optional now. FSSAI licence and bank proof are needed before approval.'),
      for (final t in DocType.uploadable)
        Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.fromLTRB(12, 6, 6, 6),
          decoration: BoxDecoration(
            color: c.surface,
            borderRadius: BorderRadius.circular(radiusBlock),
            border: Border.all(color: c.line),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(t.label, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
                    Text(_docs[t]?.name ?? 'Not added', style: TextStyle(color: c.muted, fontSize: 12.5)),
                  ],
                ),
              ),
              if (_docs[t] == null)
                TextButton.icon(
                  key: Key('onboard-doc-add-${t.wire}'),
                  onPressed: () => _addDoc(t),
                  icon: const Icon(Icons.add, size: 18),
                  label: const Text('Add'),
                )
              else
                IconButton(
                  key: Key('onboard-doc-remove-${t.wire}'),
                  tooltip: 'Remove',
                  onPressed: () => setState(() => _docs.remove(t)),
                  icon: const Icon(Icons.close),
                ),
            ],
          ),
        ),
    ];
  }
}
