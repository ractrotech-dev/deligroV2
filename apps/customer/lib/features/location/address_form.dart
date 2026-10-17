import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../models/address.dart';
import '../../state/location.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import 'map_picker.dart';

/// The locality of a geocoded line — "Berla, Bemetara, Chhattisgarh 491335,
/// India" → "Bemetara" (src/lib/utils/address-locality.ts): the segment just
/// before the one holding the PIN, else the third from last.
String? addressLocality(String? line) {
  if (line == null || line.isEmpty) return null;
  final parts = line.split(',').map((p) => p.trim()).where((p) => p.isNotEmpty).toList();
  final pin = parts.indexWhere((p) => RegExp(r'\d{6}').hasMatch(p));
  if (pin > 0) return parts[pin - 1];
  return parts.length >= 3 ? parts[parts.length - 3] : null;
}

const _presetLabels = ['Home', 'Work', 'Other'];
const _minLine = 6;
const _maxLine = 300;

/// "Add address" sheet (components/addresses/add-address-form.tsx plus the
/// flat/landmark fields from the checkout details sheet). Returns the saved
/// address, or null if the customer backed out.
Future<SavedAddress?> showAddAddressSheet(
  BuildContext context,
  WidgetRef ref, {
  PickedPin? pin,
}) {
  // The very first address becomes the default unless they say otherwise.
  final first = (ref.read(addressesProvider).value ?? const []).isEmpty;
  return showModalBottomSheet<SavedAddress>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    useRootNavigator: true,
    builder: (_) => _AddAddressSheet(pin: pin, makeDefault: first),
  );
}

class _AddAddressSheet extends ConsumerStatefulWidget {
  const _AddAddressSheet({this.pin, required this.makeDefault});
  final PickedPin? pin;
  final bool makeDefault;

  @override
  ConsumerState<_AddAddressSheet> createState() => _AddAddressSheetState();
}

class _AddAddressSheetState extends ConsumerState<_AddAddressSheet> {
  final _house = TextEditingController();
  final _street = TextEditingController();
  final _landmark = TextEditingController();
  final _custom = TextEditingController();

  String _label = 'Home';
  bool _customLabel = false;
  late bool _makeDefault = widget.makeDefault;
  PickedPin? _pin;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _pin = widget.pin;
    if (_pin?.line != null) _street.text = _pin!.line!;
    for (final c in [_house, _street, _landmark]) {
      c.addListener(_changed);
    }
  }

  void _changed() => setState(() {});

  @override
  void dispose() {
    for (final c in [_house, _street, _landmark, _custom]) {
      c.dispose();
    }
    super.dispose();
  }

  /// One `line`, the way the web joins the extra fields onto the address.
  String get _line => [_house.text, _street.text, _landmark.text]
      .map((s) => s.trim())
      .where((s) => s.isNotEmpty)
      .join(', ');

  String get _effectiveLabel {
    if (!_customLabel) return _label;
    final t = _custom.text.trim();
    return t.isEmpty ? 'Other' : t;
  }

  Future<void> _pickPin() async {
    final loc = ref.read(locationProvider);
    final picked = await showMapPicker(
      context,
      lat: _pin?.lat ?? (loc.isFallback ? null : loc.lat),
      lng: _pin?.lng ?? (loc.isFallback ? null : loc.lng),
    );
    if (picked == null || !mounted) return;
    setState(() {
      _pin = picked;
      // Prefill only an empty street: never overwrite what they typed.
      if (_street.text.trim().isEmpty && picked.line != null) _street.text = picked.line!;
    });
  }

  Future<void> _save() async {
    final line = _line;
    if (line.length < _minLine) {
      setState(() => _error = 'Enter a complete street address.');
      return;
    }
    if (line.length > _maxLine) {
      setState(() => _error = 'Keep the address under $_maxLine characters.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final saved = await ref.read(addressesProvider.notifier).add(
            label: _effectiveLabel,
            line: line,
            lat: _pin?.lat,
            lng: _pin?.lng,
            isDefault: _makeDefault,
          );
      if (mounted) Navigator.of(context).pop(saved);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.friendly);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not save address. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final line = _line;
    final inset = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: inset),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('New address', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 4),
            Text('Pin it on the map so we can check we deliver there.',
                style: TextStyle(color: c.muted, fontSize: 13)),
            const SizedBox(height: 16),
            _PinButton(pin: _pin, onTap: _busy ? null : _pickPin),
            const SizedBox(height: 18),
            Text('SAVE AS', style: Theme.of(context).textTheme.labelSmall),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final l in _presetLabels)
                  ChoiceChip(
                    label: Text(l),
                    selected: !_customLabel && _label == l,
                    showCheckmark: false,
                    onSelected: (_) => setState(() {
                      _label = l;
                      _customLabel = false;
                    }),
                  ),
                ChoiceChip(
                  avatar: Icon(Icons.edit_rounded, size: 16, color: c.muted),
                  label: const Text('Custom'),
                  selected: _customLabel,
                  showCheckmark: false,
                  onSelected: (_) => setState(() => _customLabel = true),
                ),
              ],
            ),
            if (_customLabel) ...[
              const SizedBox(height: 10),
              TextField(
                controller: _custom,
                autofocus: true,
                maxLength: 24,
                textCapitalization: TextCapitalization.words,
                decoration: const InputDecoration(
                  hintText: 'Name this address, e.g. Mom\'s place',
                  counterText: '',
                ),
              ),
            ],
            const SizedBox(height: 16),
            TextField(
              controller: _house,
              textCapitalization: TextCapitalization.words,
              textInputAction: TextInputAction.next,
              decoration: const InputDecoration(labelText: 'House / flat no., floor'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _street,
              textCapitalization: TextCapitalization.words,
              textInputAction: TextInputAction.next,
              minLines: 1,
              maxLines: 3,
              decoration: const InputDecoration(labelText: 'Building, street, area'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _landmark,
              textCapitalization: TextCapitalization.sentences,
              textInputAction: TextInputAction.done,
              decoration: const InputDecoration(
                labelText: 'Landmark or instructions (optional)',
                hintText: 'Near the temple, blue gate',
              ),
            ),
            if (line.length > _maxLine - 40)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('${line.length}/$_maxLine',
                    textAlign: TextAlign.right,
                    style: dataStyle(context, size: 12, weight: FontWeight.w500).copyWith(
                      color: line.length > _maxLine ? c.deal : c.muted,
                    )),
              ),
            const SizedBox(height: 6),
            SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              value: _makeDefault,
              onChanged: _busy ? null : (v) => setState(() => _makeDefault = v),
              title: const Text('Make this my default', style: TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text('Used first at checkout', style: TextStyle(color: c.muted, fontSize: 13)),
            ),
            if (_error != null) ...[
              const SizedBox(height: 4),
              Text(_error!, style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
            ],
            const SizedBox(height: 14),
            FilledButton(
              onPressed: _busy || line.length < _minLine ? null : _save,
              child: _busy
                  ? SizedBox(
                      width: 22,
                      height: 22,
                      child: CircularProgressIndicator(strokeWidth: 2.4, color: c.muted),
                    )
                  : const Text('Save address'),
            ),
          ],
        ),
      ),
    );
  }
}

class _PinButton extends StatelessWidget {
  const _PinButton({required this.pin, required this.onTap});
  final PickedPin? pin;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final pinned = pin != null;
    final where = pin?.label ?? addressLocality(pin?.line);
    return Material(
      color: pinned ? c.greenSoft : c.accentSoft,
      borderRadius: BorderRadius.circular(radiusBlock),
      child: InkWell(
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              Icon(pinned ? Icons.check_circle_rounded : Icons.add_location_alt_rounded,
                  color: pinned ? c.green : c.accentInk),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      pinned ? 'Pinned on map' : 'Pin on map',
                      style: TextStyle(fontWeight: FontWeight.w800, color: c.ink),
                    ),
                    Text(
                      pinned
                          ? (where ?? 'Location set')
                          : 'Helps the courier find your door',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, color: c.muted),
                    ),
                  ],
                ),
              ),
              Text(pinned ? 'Move' : 'Open map',
                  style: TextStyle(fontWeight: FontWeight.w800, color: pinned ? c.green : c.accentInk)),
            ],
          ),
        ),
      ),
    );
  }
}
