import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/i18n.dart';
import '../../models/store.dart';
import '../../state/menu.dart';
import '../../state/session.dart';
import '../../state/store.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

/// The storefront details customers see: name, tagline, description,
/// cuisines, phone, cover photo, and where the shop is.
class StoreEditScreen extends ConsumerWidget {
  const StoreEditScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(storeProvider);
    return switch (async) {
      AsyncData(:final value) => _StoreEditForm(store: value.store),
      AsyncError(:final error) => Scaffold(
          appBar: AppBar(),
          body: LoadFailed(error: error, onRetry: () => ref.invalidate(storeProvider)),
        ),
      _ => Scaffold(appBar: AppBar(), body: const Center(child: CircularProgressIndicator())),
    };
  }
}

class _StoreEditForm extends ConsumerStatefulWidget {
  const _StoreEditForm({required this.store});

  final StoreInfo store;

  @override
  ConsumerState<_StoreEditForm> createState() => _StoreEditFormState();
}

class _StoreEditFormState extends ConsumerState<_StoreEditForm> {
  final _form = GlobalKey<FormState>();
  late final _name = TextEditingController(text: widget.store.name);
  late final _tagline = TextEditingController(text: widget.store.tagline ?? '');
  late final _description = TextEditingController(text: widget.store.description ?? '');
  late final _cuisines = TextEditingController(text: widget.store.cuisines.join(', '));
  late final _phone = TextEditingController(text: widget.store.shopPhone ?? '');
  late final _address = TextEditingController(text: widget.store.address ?? '');
  late final _landmark = TextEditingController(text: widget.store.landmark ?? '');
  late final _pincode = TextEditingController(text: widget.store.pincode ?? '');
  late double? _lat = widget.store.lat;
  late double? _lng = widget.store.lng;
  late String? _imageUrl = widget.store.imageUrl;
  bool _saving = false;
  bool _locating = false;
  bool _uploading = false;

  @override
  void dispose() {
    for (final c in [_name, _tagline, _description, _cuisines, _phone, _address, _landmark, _pincode]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _locate() async {
    setState(() => _locating = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        messenger.showSnackBar(SnackBar(
            content: Text(trNow(ref, 'Allow location to pin the shop here.', 'दुकान यहाँ पिन करने के लिए लोकेशन की अनुमति दें।'))));
        return;
      }
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 20)),
      );
      setState(() {
        _lat = pos.latitude;
        _lng = pos.longitude;
      });
    } catch (_) {
      messenger.showSnackBar(SnackBar(
          content: Text(trNow(ref, 'Couldn\'t get your location. Is GPS on?', 'लोकेशन नहीं मिली। क्या GPS चालू है?'))));
    } finally {
      if (mounted) setState(() => _locating = false);
    }
  }

  Future<void> _pickPhoto() async {
    final file = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1600, imageQuality: 82);
    if (file == null) return;
    setState(() => _uploading = true);
    if (!mounted) return;
    await runWrite(context, ref, () async {
      final url = await ref.read(menuRepoProvider).uploadPhoto(widget.store.id, await file.readAsBytes());
      if (mounted) setState(() => _imageUrl = url);
    });
    if (mounted) setState(() => _uploading = false);
  }

  /// Only what changed goes up, so a field the shop may not edit is never sent.
  Map<String, Object?> _changes() {
    final s = widget.store;
    String? opt(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();
    final out = <String, Object?>{};
    if (_name.text.trim() != s.name) out['name'] = _name.text.trim();
    if (opt(_tagline) != s.tagline) out['tagline'] = opt(_tagline);
    if (opt(_description) != s.description) out['description'] = opt(_description);
    final cuisines = _cuisines.text.split(',').map((c) => c.trim()).where((c) => c.isNotEmpty).toSet().toList();
    if (cuisines.join('|') != s.cuisines.join('|')) out['cuisines'] = cuisines;
    if (s.scheduleSupported && opt(_phone) != s.shopPhone) out['shopPhone'] = opt(_phone);
    if (_imageUrl != s.imageUrl) out['imageUrl'] = _imageUrl;
    if (opt(_landmark) != s.landmark) out['landmark'] = opt(_landmark);
    if (opt(_pincode) != s.pincode) out['pincode'] = opt(_pincode);
    if (_lat != null && (_address.text.trim() != (s.address ?? '') || _lat != s.lat || _lng != s.lng)) {
      out['address'] = _address.text.trim();
      out['lat'] = _lat;
      out['lng'] = _lng;
    }
    return out;
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    final changes = _changes();
    if (changes.isEmpty) {
      Navigator.of(context).pop();
      return;
    }
    setState(() => _saving = true);
    final ok = await runWrite(context, ref, () async {
      ref.read(storeProvider.notifier).adopt(await ref.read(storeRepoProvider).update(changes));
    }, doneEn: 'Store details saved', doneHi: 'दुकान की जानकारी सेव हो गई');
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok) {
      if (changes.containsKey('name')) ref.read(vendorMeProvider.notifier).reload();
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = widget.store;
    String? required(String? v) => (v ?? '').trim().isEmpty ? trNow(ref, 'Required', 'ज़रूरी है') : null;
    InputDecoration deco(String label, {String? hint}) => InputDecoration(labelText: label, hintText: hint);

    return Scaffold(
      appBar: AppBar(
        title: Text(tr(ref, 'Store details', 'दुकान की जानकारी')),
        actions: [
          TextButton(
            onPressed: _saving || _uploading ? null : _save,
            child: _saving
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(tr(ref, 'Save', 'सेव करें')),
          ),
        ],
      ),
      body: Form(
        key: _form,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            AspectRatio(
              aspectRatio: 16 / 7,
              child: Material(
                color: c.surface2,
                borderRadius: BorderRadius.circular(radiusBlock),
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  onTap: _uploading ? null : _pickPhoto,
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      if (_imageUrl != null) CachedNetworkImage(imageUrl: _imageUrl!, fit: BoxFit.cover),
                      Center(
                        child: _uploading
                            ? const CircularProgressIndicator()
                            : Chip(
                                avatar: const Icon(Icons.photo_camera_outlined, size: 18),
                                label: Text(_imageUrl == null
                                    ? tr(ref, 'Add cover photo', 'कवर फ़ोटो जोड़ें')
                                    : tr(ref, 'Change photo', 'फ़ोटो बदलें')),
                              ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 20),
            TextFormField(controller: _name, decoration: deco(tr(ref, 'Shop name', 'दुकान का नाम')), maxLength: 80, validator: required),
            TextFormField(
              controller: _tagline,
              decoration: deco(tr(ref, 'Tagline', 'टैगलाइन'), hint: tr(ref, 'e.g. Fresh rolls since 1998', 'जैसे 1998 से ताज़े रोल')),
              maxLength: 120,
            ),
            TextFormField(
              controller: _description,
              decoration: deco(tr(ref, 'About the shop', 'दुकान के बारे में')),
              maxLength: 600,
              minLines: 2,
              maxLines: 5,
            ),
            TextFormField(
              controller: _cuisines,
              decoration: deco(tr(ref, 'Cuisines', 'व्यंजन'), hint: tr(ref, 'North Indian, Chinese', 'उत्तर भारतीय, चाइनीज़')),
              validator: (v) => (v ?? '').split(',').where((x) => x.trim().isNotEmpty).length > 8
                  ? trNow(ref, 'At most 8', 'ज़्यादा से ज़्यादा 8')
                  : null,
            ),
            if (s.scheduleSupported) ...[
              const SizedBox(height: 12),
              TextFormField(
                controller: _phone,
                keyboardType: TextInputType.phone,
                decoration: deco(tr(ref, 'Shop phone (shown to customers)', 'दुकान का फ़ोन (ग्राहकों को दिखेगा)')),
                validator: (v) => (v ?? '').trim().isEmpty || RegExp(r'^\+?[0-9 -]{6,20}$').hasMatch(v!.trim())
                    ? null
                    : trNow(ref, 'Digits only', 'सिर्फ़ अंक'),
              ),
            ],
            const SizedBox(height: 24),
            Text(tr(ref, 'LOCATION', 'जगह'),
                style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w700, letterSpacing: .4)),
            const SizedBox(height: 8),
            TextFormField(
              controller: _address,
              decoration: deco(tr(ref, 'Address', 'पता')),
              maxLength: 300,
              minLines: 1,
              maxLines: 3,
              validator: required,
            ),
            TextFormField(controller: _landmark, decoration: deco(tr(ref, 'Landmark', 'लैंडमार्क')), maxLength: 120),
            TextFormField(
              controller: _pincode,
              decoration: deco(tr(ref, 'Pincode', 'पिनकोड')),
              keyboardType: TextInputType.number,
              maxLength: 6,
              validator: (v) => (v ?? '').trim().isEmpty || RegExp(r'^\d{6}$').hasMatch(v!.trim())
                  ? null
                  : trNow(ref, '6 digits', '6 अंक'),
            ),
            const SizedBox(height: 8),
            Panel(
              padding: const EdgeInsets.all(14),
              child: Row(
                children: [
                  Icon(Icons.my_location_rounded, color: _lat == null ? c.muted : c.green),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      _lat == null
                          ? tr(ref, 'Not pinned yet. Stand in the shop and tap Use my location.',
                              'अभी पिन नहीं है। दुकान में खड़े होकर "मेरी लोकेशन" दबाएँ।')
                          : '${_lat!.toStringAsFixed(5)}, ${_lng!.toStringAsFixed(5)}',
                      style: TextStyle(color: _lat == null ? c.muted : c.ink),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: _locating ? null : _locate,
              icon: _locating
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.gps_fixed_rounded),
              label: Text(tr(ref, 'Use my location', 'मेरी लोकेशन इस्तेमाल करें')),
            ),
            const SizedBox(height: 6),
            Text(
              tr(ref, 'Customers\' distance and delivery fee are worked out from this pin.',
                  'ग्राहक की दूरी और डिलीवरी शुल्क इसी पिन से तय होते हैं।'),
              style: TextStyle(color: c.muted, fontSize: 12.5),
            ),
          ],
        ),
      ),
    );
  }
}
