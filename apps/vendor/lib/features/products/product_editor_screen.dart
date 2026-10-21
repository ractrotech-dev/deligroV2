import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../core/format.dart';
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
            body: Center(child: Text('This item no longer exists.')),
          );
        }
        return _Editor(menu: value, item: item);
      }(),
      AsyncError(:final error) => Scaffold(
        appBar: AppBar(),
        body: LoadFailed(error: error, onRetry: () => ref.invalidate(menuProvider)),
      ),
      _ => Scaffold(
        appBar: AppBar(),
        body: const Center(child: CircularProgressIndicator()),
      ),
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
    }, done: _orig == null ? 'Item added' : 'Item saved');
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok) {
      await ref.read(menuProvider.notifier).refresh();
      if (mounted) Navigator.of(context).pop();
    }
  }

  Future<void> _duplicate() async {
    final ok = await runWrite(context, ref, () => ref.read(menuRepoProvider).duplicate(_orig!.id), done: 'Copy added');
    if (ok) {
      await ref.read(menuProvider.notifier).refresh();
      if (mounted) Navigator.of(context).pop();
    }
  }

  Future<void> _delete() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text('Delete ${_orig!.name}?'),
        content: Text(
          'It leaves the menu for good. Past orders keep it. To hide it for now, switch off Available instead.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: context.colors.deal),
            onPressed: () => Navigator.pop(d, true),
            child: Text('Delete'),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    final ok = await runWrite(context, ref, () => ref.read(menuRepoProvider).delete(_orig!.id), done: 'Item deleted');
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
    String? required(String? v) => (v ?? '').trim().isEmpty ? 'Required' : null;
    String? wholeNumber(String? v) {
      final n = int.tryParse((v ?? '').trim());
      return n == null || n < 0 ? 'Whole number' : null;
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(o == null ? 'Add item' : 'Edit item'),
        actions: [
          if (o != null && canEdit)
            PopupMenuButton<String>(
              onSelected: (v) => v == 'copy' ? _duplicate() : _delete(),
              itemBuilder: (_) => [
                PopupMenuItem(value: 'copy', child: Text('Duplicate')),
                PopupMenuItem(
                  value: 'delete',
                  child: Text('Delete', style: TextStyle(color: c.deal)),
                ),
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
                      : Text(o == null ? 'Add item' : 'Save changes'),
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
                  child: Panel(tint: c.surface2, child: Text('Deligro has made your menu read-only.')),
                ),
              if (o != null) ...[
                const SizedBox(height: 12),
                Panel(
                  child: Row(
                    children: [
                      Expanded(
                        child: _Stat(label: 'Units sold', value: '${o.soldCount}'),
                      ),
                      Expanded(
                        child: _Stat(label: 'Sales', value: rupees(o.soldRevenue)),
                      ),
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 16),
              _photo(c),
              SectionHeading('Details'),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Column(
                  children: [
                    TextFormField(
                      controller: _name,
                      decoration: InputDecoration(labelText: 'Item name'),
                      maxLength: 120,
                      validator: required,
                    ),
                    TextFormField(
                      controller: _price,
                      decoration: InputDecoration(
                        labelText: _variants.isEmpty ? 'Price (₹)' : 'Base price (₹)',
                        helperText: _variants.isEmpty ? null : 'Sizes below set the real price',
                      ),
                      keyboardType: TextInputType.number,
                      validator: (v) {
                        final n = int.tryParse((v ?? '').trim());
                        return n == null || n < 0 || n > 100000 ? 'Whole rupees' : null;
                      },
                    ),
                    const SizedBox(height: 12),
                    Autocomplete<String>(
                      initialValue: TextEditingValue(text: _category.text),
                      optionsBuilder: (v) =>
                          widget.menu.categories.where((cat) => cat.toLowerCase().contains(v.text.toLowerCase())),
                      onSelected: (v) => _category.text = v,
                      fieldViewBuilder: (_, ctrl, focus, _) => TextFormField(
                        controller: ctrl,
                        focusNode: focus,
                        maxLength: 40,
                        onChanged: (v) => _category.text = v,
                        decoration: InputDecoration(labelText: 'Category'),
                      ),
                    ),
                    const SizedBox(height: 4),
                    SizedBox(
                      width: double.infinity,
                      child: SegmentedButton<bool>(
                        segments: [
                          ButtonSegment(value: true, icon: const VegMark(veg: true, size: 12), label: Text('Veg')),
                          ButtonSegment(
                            value: false,
                            icon: const VegMark(veg: false, size: 12),
                            label: Text('Non-veg'),
                          ),
                        ],
                        selected: {_veg},
                        showSelectedIcon: false,
                        onSelectionChanged: (s) => setState(() => _veg = s.first),
                      ),
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _description,
                      decoration: InputDecoration(labelText: 'Description'),
                      maxLength: 500,
                      minLines: 2,
                      maxLines: 4,
                    ),
                  ],
                ),
              ),
              SectionHeading('Availability'),
              Panel(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Column(
                  children: [
                    SwitchListTile(
                      title: Text('Available', style: const TextStyle(fontWeight: FontWeight.w700)),
                      subtitle: Text('Off shows it as sold out'),
                      value: _available,
                      onChanged: (v) => setState(() => _available = v),
                    ),
                    SwitchListTile(
                      title: Text('Popular'),
                      value: _popular,
                      onChanged: (v) => setState(() => _popular = v),
                    ),
                    SwitchListTile(
                      title: Text('Bestseller'),
                      value: _bestseller,
                      onChanged: (v) => setState(() => _bestseller = v),
                    ),
                  ],
                ),
              ),
              if (_inventory) ...[
                SectionHeading('Stock'),
                Panel(
                  padding: const EdgeInsets.fromLTRB(0, 4, 0, 12),
                  child: Column(
                    children: [
                      SwitchListTile(
                        title: Text('Count stock', style: const TextStyle(fontWeight: FontWeight.w700)),
                        subtitle: Text('Each order takes units off. At 0 the item turns sold out by itself.'),
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
                                  decoration: InputDecoration(labelText: 'Units in stock'),
                                  validator: wholeNumber,
                                ),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: TextFormField(
                                  controller: _lowAt,
                                  keyboardType: TextInputType.number,
                                  decoration: InputDecoration(labelText: 'Alert me at', helperText: 'Low-stock alert'),
                                  validator: (v) => (v ?? '').trim().isEmpty ? null : wholeNumber(v),
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
                SectionHeading('When it\'s offered'),
                _schedule(c),
                SectionHeading('Sizes and add-ons'),
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
                ? ColoredBox(
                    color: c.surface2,
                    child: const Center(child: CircularProgressIndicator()),
                  )
                : _imageUrl == null
                ? ColoredBox(
                    color: c.surface2,
                    child: Icon(Icons.add_a_photo_outlined, color: c.muted, size: 30),
                  )
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
                label: Text('Camera'),
              ),
              OutlinedButton.icon(
                onPressed: _uploading ? null : () => _pickPhoto(ImageSource.gallery),
                icon: const Icon(Icons.photo_library_outlined, size: 18),
                label: Text('Gallery'),
              ),
              if (_imageUrl != null)
                TextButton(onPressed: () => setState(() => _imageUrl = null), child: Text('Remove')),
            ],
          ),
        ),
      ],
    ),
  );

  Widget _schedule(AppColors c) {
    const short = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    final windowed = _from != null && _to != null;
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            _dayList == null ? 'Every day' : 'Only on the days picked',
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (var i = 0; i < 7; i++)
                FilterChip(
                  label: Text(short[i]),
                  selected: _days.contains(i),
                  onSelected: (on) => setState(() => on ? _days.add(i) : _days.remove(i)),
                ),
            ],
          ),
          const SizedBox(height: 14),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: Text('Only at certain times', style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: Text(windowed ? '${clock12(_from)} – ${clock12(_to)}' : 'e.g. breakfast 7–11 AM'),
            value: windowed,
            onChanged: (on) async {
              if (!on) {
                setState(() => _from = _to = null);
                return;
              }
              final from = await showTimePicker(
                context: context,
                initialTime: timeOf(_from) ?? const TimeOfDay(hour: 7, minute: 0),
                helpText: 'Available from',
              );
              if (from == null || !mounted) return;
              final to = await showTimePicker(
                context: context,
                initialTime: timeOf(_to) ?? const TimeOfDay(hour: 11, minute: 0),
                helpText: 'Available until',
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
