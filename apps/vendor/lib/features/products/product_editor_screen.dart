import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/format.dart';
import '../../core/i18n.dart';
import '../../models/menu.dart';
import '../../state/menu.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';
import 'options_editor.dart';
import 'products_screen.dart';

/// Add or edit one item: details, photo, availability, stock, when it is
/// offered, and its sizes and add-ons. [itemId] null = a new item.
class ProductEditorScreen extends ConsumerWidget {
  const ProductEditorScreen({super.key, this.itemId});

  final String? itemId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(menuProvider);
    return switch (async) {
      AsyncData(:final value) => () {
          final item = itemId == null ? null : value.items.where((i) => i.id == itemId).firstOrNull;
          if (itemId != null && item == null) {
            return Scaffold(
              appBar: AppBar(),
              body: Center(child: Text(tr(ref, 'This item no longer exists.', 'यह आइटम अब नहीं है।'))),
            );
          }
          return _Editor(menu: value, item: item);
        }(),
      AsyncError(:final error) => Scaffold(
          appBar: AppBar(),
          body: LoadFailed(error: error, onRetry: () => ref.invalidate(menuProvider)),
        ),
      _ => Scaffold(appBar: AppBar(), body: const Center(child: CircularProgressIndicator())),
    };
  }
}

class _Editor extends ConsumerStatefulWidget {
  const _Editor({required this.menu, this.item});

  final Menu menu;
  final MenuItem? item;

  @override
  ConsumerState<_Editor> createState() => _EditorState();
}

class _EditorState extends ConsumerState<_Editor> {
  final _form = GlobalKey<FormState>();
  MenuItem? get _orig => widget.item;

  late final _name = TextEditingController(text: _orig?.name ?? '');
  late final _price = TextEditingController(text: _orig == null ? '' : '${_orig!.price}');
  late final _category = TextEditingController(text: _orig?.category ?? (widget.menu.categories.firstOrNull ?? ''));
  late final _description = TextEditingController(text: _orig?.description ?? '');
  late final _stock = TextEditingController(text: _orig?.stockQty?.toString() ?? '');
  late final _lowAt = TextEditingController(text: _orig?.lowStockAt?.toString() ?? '');
  late bool _veg = _orig?.veg ?? true;
  late bool _available = _orig?.available ?? true;
  late bool _popular = _orig?.popular ?? false;
  late bool _bestseller = _orig?.bestseller ?? false;
  late String? _imageUrl = _orig?.imageUrl;
  late bool _trackStock = _orig?.tracksStock ?? false;
  late final Set<int> _days = {...?_orig?.availableDays};
  late String? _from = _orig?.availableFrom;
  late String? _to = _orig?.availableTo;
  late List<MenuOption> _variants = [...?_orig?.variants];
  late List<AddonGroup> _groups = [...?_orig?.addonGroups];
  bool _saving = false;
  bool _uploading = false;

  @override
  void dispose() {
    for (final c in [_name, _price, _category, _description, _stock, _lowAt]) {
      c.dispose();
    }
    super.dispose();
  }

  bool get _inventory => widget.menu.inventorySupported;

  /// Days as the server wants them: null = every day.
  List<int>? get _dayList => _days.isEmpty || _days.length == 7 ? null : (_days.toList()..sort());

  Map<String, Object?> _fields() {
    final f = <String, Object?>{
      'name': _name.text.trim(),
      'price': int.parse(_price.text.trim()),
      'category': _category.text.trim(),
      'veg': _veg,
      'description': _description.text.trim(),
      'available': _available,
      'popular': _popular,
      'bestseller': _bestseller,
      'imageUrl': _imageUrl,
    };
    if (_inventory) {
      f['stockQty'] = _trackStock ? int.parse(_stock.text.trim()) : null;
      f['lowStockAt'] = _trackStock && _lowAt.text.trim().isNotEmpty ? int.parse(_lowAt.text.trim()) : null;
      f['availableDays'] = _dayList;
      f['availableFrom'] = _from;
      f['availableTo'] = _to;
    }
    return f;
  }

  /// The fields that differ from the saved item, so an edit stays small.
  Map<String, Object?> _changed() {
    final o = _orig!;
    final all = _fields();
    final before = <String, Object?>{
      'name': o.name,
      'price': o.price,
      'category': o.category,
      'veg': o.veg,
      'description': o.description,
      'available': o.available,
      'popular': o.popular,
      'bestseller': o.bestseller,
      'imageUrl': o.imageUrl,
      'stockQty': o.stockQty,
      'lowStockAt': o.lowStockAt,
      'availableDays': o.availableDays,
      'availableFrom': o.availableFrom,
      'availableTo': o.availableTo,
    };
    String key(Object? v) => v is List ? v.join(',') : '$v';
    return {
      for (final e in all.entries)
        if (key(e.value) != key(before[e.key])) e.key: e.value,
    };
  }

  bool _optionsChanged() {
    final o = _orig;
    String sig(List<MenuOption> v, List<AddonGroup> g) =>
        '${[for (final x in v) x.toJson()]}|${[for (final x in g) x.toJson()]}';
    return sig(_variants, _groups) != sig(o?.variants ?? const [], o?.addonGroups ?? const []);
  }

  Future<void> _pickPhoto(ImageSource source) async {
    final file = await ImagePicker().pickImage(source: source, maxWidth: 1200, imageQuality: 80);
    if (file == null || !mounted) return;
    setState(() => _uploading = true);
    await runWrite(context, ref, () async {
      final url = await ref.read(menuRepoProvider).uploadPhoto(widget.menu.restaurantId, await file.readAsBytes());
      if (mounted) setState(() => _imageUrl = url);
    });
    if (mounted) setState(() => _uploading = false);
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    if ((_from == null) != (_to == null)) return;
    setState(() => _saving = true);
    final repo = ref.read(menuRepoProvider);
    final ok = await runWrite(context, ref, () async {
      var id = _orig?.id;
      if (id == null) {
        id = await repo.create(_fields());
      } else {
        final changes = _changed();
        if (changes.isNotEmpty) await repo.update(id, changes);
      }
      if (_inventory && _optionsChanged()) await repo.setOptions(id, _variants, _groups);
    }, doneEn: _orig == null ? 'Item added' : 'Item saved', doneHi: _orig == null ? 'आइटम जुड़ गया' : 'आइटम सेव हुआ');
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok) {
      await ref.read(menuProvider.notifier).refresh();
      if (mounted) Navigator.of(context).pop();
    }
  }

  Future<void> _duplicate() async {
    final ok = await runWrite(context, ref, () => ref.read(menuRepoProvider).duplicate(_orig!.id),
        doneEn: 'Copy added', doneHi: 'कॉपी जुड़ गई');
    if (ok) {
      await ref.read(menuProvider.notifier).refresh();
      if (mounted) Navigator.of(context).pop();
    }
  }

  Future<void> _delete() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text(trNow(ref, 'Delete ${_orig!.name}?', '${_orig!.name} हटाएँ?')),
        content: Text(trNow(ref, 'It leaves the menu for good. Past orders keep it. To hide it for now, switch off Available instead.',
            'यह मेन्यू से हमेशा के लिए हट जाएगा। पुराने ऑर्डर में बना रहेगा। अभी के लिए छिपाना हो तो "उपलब्ध" बंद करें।')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: Text(trNow(ref, 'Cancel', 'रद्द करें'))),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: context.colors.deal),
            onPressed: () => Navigator.pop(d, true),
            child: Text(trNow(ref, 'Delete', 'हटाएँ')),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    final ok = await runWrite(context, ref, () => ref.read(menuRepoProvider).delete(_orig!.id),
        doneEn: 'Item deleted', doneHi: 'आइटम हटाया');
    if (ok) {
      await ref.read(menuProvider.notifier).refresh();
      if (mounted) Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final canEdit = widget.menu.canEdit;
    final o = _orig;
    String? required(String? v) => (v ?? '').trim().isEmpty ? trNow(ref, 'Required', 'ज़रूरी है') : null;
    String? wholeNumber(String? v) {
      final n = int.tryParse((v ?? '').trim());
      return n == null || n < 0 ? trNow(ref, 'Whole number', 'पूरी संख्या') : null;
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(o == null ? tr(ref, 'Add item', 'आइटम जोड़ें') : tr(ref, 'Edit item', 'आइटम बदलें')),
        actions: [
          if (o != null && canEdit)
            PopupMenuButton<String>(
              onSelected: (v) => v == 'copy' ? _duplicate() : _delete(),
              itemBuilder: (_) => [
                PopupMenuItem(value: 'copy', child: Text(trNow(ref, 'Duplicate', 'कॉपी बनाएँ'))),
                PopupMenuItem(value: 'delete', child: Text(trNow(ref, 'Delete', 'हटाएँ'), style: TextStyle(color: c.deal))),
              ],
            ),
        ],
      ),
      bottomNavigationBar: canEdit
          ? SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: FilledButton(
                  onPressed: _saving || _uploading ? null : _save,
                  child: _saving
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                      : Text(o == null ? tr(ref, 'Add item', 'आइटम जोड़ें') : tr(ref, 'Save changes', 'बदलाव सेव करें')),
                ),
              ),
            )
          : null,
      body: AbsorbPointer(
        absorbing: !canEdit,
        child: Form(
          key: _form,
          child: ListView(
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              if (!canEdit)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                  child: Panel(
                    tint: c.surface2,
                    child: Text(tr(ref, 'Deligro has made your menu read-only.', 'Deligro ने आपका मेन्यू सिर्फ़ देखने लायक किया है।')),
                  ),
                ),
              if (o != null) ...[
                const SizedBox(height: 12),
                Panel(
                  child: Row(
                    children: [
                      Expanded(child: _Stat(label: tr(ref, 'Units sold', 'बिकी यूनिट'), value: '${o.soldCount}')),
                      Expanded(child: _Stat(label: tr(ref, 'Sales', 'बिक्री'), value: rupees(o.soldRevenue))),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 16),
              _photo(c),
              SectionHeading(tr(ref, 'Details', 'जानकारी')),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Column(
                  children: [
                    TextFormField(
                      controller: _name,
                      decoration: InputDecoration(labelText: tr(ref, 'Item name', 'आइटम का नाम')),
                      maxLength: 120,
                      validator: required,
                    ),
                    TextFormField(
                      controller: _price,
                      decoration: InputDecoration(
                        labelText: _variants.isEmpty ? tr(ref, 'Price (₹)', 'कीमत (₹)') : tr(ref, 'Base price (₹)', 'मूल कीमत (₹)'),
                        helperText: _variants.isEmpty ? null : tr(ref, 'Sizes below set the real price', 'असली कीमत नीचे के साइज़ से तय होगी'),
                      ),
                      keyboardType: TextInputType.number,
                      validator: (v) {
                        final n = int.tryParse((v ?? '').trim());
                        return n == null || n < 0 || n > 100000 ? trNow(ref, 'Whole rupees', 'पूरे रुपये') : null;
                      },
                    ),
                    const SizedBox(height: 12),
                    Autocomplete<String>(
                      initialValue: TextEditingValue(text: _category.text),
                      optionsBuilder: (v) => widget.menu.categories
                          .where((cat) => cat.toLowerCase().contains(v.text.toLowerCase())),
                      onSelected: (v) => _category.text = v,
                      fieldViewBuilder: (_, ctrl, focus, _) => TextFormField(
                        controller: ctrl,
                        focusNode: focus,
                        maxLength: 40,
                        onChanged: (v) => _category.text = v,
                        decoration: InputDecoration(labelText: tr(ref, 'Category', 'श्रेणी')),
                      ),
                    ),
                    const SizedBox(height: 4),
                    SizedBox(
                      width: double.infinity,
                      child: SegmentedButton<bool>(
                        segments: [
                          ButtonSegment(value: true, icon: const VegMark(veg: true, size: 12), label: Text(tr(ref, 'Veg', 'शाकाहारी'))),
                          ButtonSegment(value: false, icon: const VegMark(veg: false, size: 12), label: Text(tr(ref, 'Non-veg', 'मांसाहारी'))),
                        ],
                        selected: {_veg},
                        showSelectedIcon: false,
                        onSelectionChanged: (s) => setState(() => _veg = s.first),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _description,
                      decoration: InputDecoration(labelText: tr(ref, 'Description', 'विवरण')),
                      maxLength: 500,
                      minLines: 2,
                      maxLines: 4,
                    ),
                  ],
                ),
              ),
              SectionHeading(tr(ref, 'Availability', 'उपलब्धता')),
              Panel(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Column(
                  children: [
                    SwitchListTile(
                      title: Text(tr(ref, 'Available', 'उपलब्ध'), style: const TextStyle(fontWeight: FontWeight.w700)),
                      subtitle: Text(tr(ref, 'Off shows it as sold out', 'बंद करने पर "खत्म" दिखेगा')),
                      value: _available,
                      onChanged: (v) => setState(() => _available = v),
                    ),
                    SwitchListTile(
                      title: Text(tr(ref, 'Popular', 'लोकप्रिय')),
                      value: _popular,
                      onChanged: (v) => setState(() => _popular = v),
                    ),
                    SwitchListTile(
                      title: Text(tr(ref, 'Bestseller', 'बेस्टसेलर')),
                      value: _bestseller,
                      onChanged: (v) => setState(() => _bestseller = v),
                    ),
                  ],
                ),
              ),
              if (_inventory) ...[
                SectionHeading(tr(ref, 'Stock', 'स्टॉक')),
                Panel(
                  padding: const EdgeInsets.fromLTRB(0, 4, 0, 12),
                  child: Column(
                    children: [
                      SwitchListTile(
                        title: Text(tr(ref, 'Count stock', 'स्टॉक गिनें'), style: const TextStyle(fontWeight: FontWeight.w700)),
                        subtitle: Text(tr(ref, 'Each order takes units off. At 0 the item turns sold out by itself.',
                            'हर ऑर्डर से यूनिट घटेंगी। 0 पर आइटम अपने आप "खत्म" हो जाएगा।')),
                        value: _trackStock,
                        onChanged: (v) => setState(() => _trackStock = v),
                      ),
                      if (_trackStock)
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 16),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Expanded(
                                child: TextFormField(
                                  controller: _stock,
                                  keyboardType: TextInputType.number,
                                  decoration: InputDecoration(labelText: tr(ref, 'Units in stock', 'स्टॉक में यूनिट')),
                                  validator: wholeNumber,
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: TextFormField(
                                  controller: _lowAt,
                                  keyboardType: TextInputType.number,
                                  decoration: InputDecoration(
                                    labelText: tr(ref, 'Alert me at', 'इतने पर अलर्ट'),
                                    helperText: tr(ref, 'Low-stock alert', 'कम स्टॉक अलर्ट'),
                                  ),
                                  validator: (v) => (v ?? '').trim().isEmpty ? null : wholeNumber(v),
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
                SectionHeading(tr(ref, 'When it\'s offered', 'कब मिलेगा')),
                _schedule(c),
                SectionHeading(tr(ref, 'Sizes and add-ons', 'साइज़ और ऐड-ऑन')),
                OptionsEditor(
                  variants: _variants,
                  groups: _groups,
                  onChanged: (v, g) => setState(() {
                    _variants = v;
                    _groups = g;
                  }),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _photo(AppColors c) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Row(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(radiusBlock),
              child: SizedBox(
                width: 96,
                height: 96,
                child: _uploading
                    ? ColoredBox(color: c.surface2, child: const Center(child: CircularProgressIndicator()))
                    : _imageUrl == null
                        ? ColoredBox(color: c.surface2, child: Icon(Icons.add_a_photo_outlined, color: c.muted, size: 30))
                        : CachedNetworkImage(imageUrl: _imageUrl!, fit: BoxFit.cover),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  OutlinedButton.icon(
                    onPressed: _uploading ? null : () => _pickPhoto(ImageSource.camera),
                    icon: const Icon(Icons.photo_camera_outlined, size: 18),
                    label: Text(tr(ref, 'Camera', 'कैमरा')),
                  ),
                  OutlinedButton.icon(
                    onPressed: _uploading ? null : () => _pickPhoto(ImageSource.gallery),
                    icon: const Icon(Icons.photo_library_outlined, size: 18),
                    label: Text(tr(ref, 'Gallery', 'गैलरी')),
                  ),
                  if (_imageUrl != null)
                    TextButton(
                      onPressed: () => setState(() => _imageUrl = null),
                      child: Text(tr(ref, 'Remove', 'हटाएँ')),
                    ),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _schedule(AppColors c) {
    const short = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const shortHi = ['रवि', 'सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि'];
    final windowed = _from != null && _to != null;
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            _dayList == null ? tr(ref, 'Every day', 'हर दिन') : tr(ref, 'Only on the days picked', 'सिर्फ़ चुने हुए दिन'),
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (var i = 0; i < 7; i++)
                FilterChip(
                  label: Text(tr(ref, short[i], shortHi[i])),
                  selected: _days.contains(i),
                  onSelected: (on) => setState(() => on ? _days.add(i) : _days.remove(i)),
                ),
            ],
          ),
          const SizedBox(height: 14),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(tr(ref, 'Only at certain times', 'सिर्फ़ तय समय पर'), style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(windowed
                ? '${clock12(_from)} – ${clock12(_to)}'
                : tr(ref, 'e.g. breakfast 7–11 AM', 'जैसे नाश्ता सुबह 7–11')),
            value: windowed,
            onChanged: (on) async {
              if (!on) {
                setState(() => _from = _to = null);
                return;
              }
              final from = await showTimePicker(
                context: context,
                initialTime: timeOf(_from) ?? const TimeOfDay(hour: 7, minute: 0),
                helpText: trNow(ref, 'Available from', 'कब से मिलेगा'),
              );
              if (from == null || !mounted) return;
              final to = await showTimePicker(
                context: context,
                initialTime: timeOf(_to) ?? const TimeOfDay(hour: 11, minute: 0),
                helpText: trNow(ref, 'Available until', 'कब तक मिलेगा'),
              );
              if (to == null || !mounted) return;
              setState(() {
                _from = hhmmOf(from);
                _to = hhmmOf(to);
              });
            },
          ),
        ],
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(color: context.colors.muted, fontSize: 12.5)),
          const SizedBox(height: 2),
          Text(value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
        ],
      );
}
