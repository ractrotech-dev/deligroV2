import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../models/outcome.dart';
import '../../models/products.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'product_tile.dart';

/// Takes or picks a photo. One seam so tests can hand back a file. The photo
/// is resized and compressed on the phone: the dish photo bucket takes 2 MB.
final dishPhotoPickerProvider = Provider<Future<XFile?> Function(ImageSource)>(
  (_) => (source) => ImagePicker().pickImage(source: source, maxWidth: 1600, imageQuality: 85),
);

enum _Source { camera, gallery, library }

/// Replace a wrong dish photo (manager.products.replace_photo): take one,
/// choose one from the phone, or pick one from the Deligro photo library. The
/// manager sees the photo and confirms before it is sent. [reviewChangeId] is
/// the review card it was opened from, which then counts as reviewed. Answers
/// true once the photo is replaced.
Future<bool> showReplacePhotoSheet(
  BuildContext context,
  WidgetRef ref, {
  required String productId,
  required String dishName,
  int? reviewChangeId,
}) async {
  final source = await showModalBottomSheet<_Source>(
    context: context,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
            child: Text('New photo for $dishName', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
          ),
          ListTile(
            key: const Key('replace-camera'),
            leading: const Icon(Icons.photo_camera_outlined),
            title: const Text('Take photo'),
            onTap: () => Navigator.pop(ctx, _Source.camera),
          ),
          ListTile(
            key: const Key('replace-gallery'),
            leading: const Icon(Icons.photo_library_outlined),
            title: const Text('Choose from gallery'),
            onTap: () => Navigator.pop(ctx, _Source.gallery),
          ),
          ListTile(
            key: const Key('replace-library'),
            leading: const Icon(Icons.collections_outlined),
            title: const Text('Deligro photo library'),
            subtitle: const Text('Photos Deligro already has for dishes like this'),
            onTap: () => Navigator.pop(ctx, _Source.library),
          ),
        ],
      ),
    ),
  );
  if (source == null || !context.mounted) return false;

  final clientActionId = const Uuid().v4();
  final repo = ref.read(productsRepoProvider);
  Future<Outcome<ProductDetail>> Function() send;
  if (source == _Source.library) {
    final photo = await Navigator.of(context).push<LibraryPhoto>(
      MaterialPageRoute(fullscreenDialog: true, builder: (_) => _LibraryPicker(productId: productId, dishName: dishName)),
    );
    if (photo == null || !context.mounted) return false;
    if (!await _confirm(context, dishName, Image.network(photo.imageUrl, fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox()))) {
      return false;
    }
    send = () => repo.replacePhotoFromLibrary(productId, photo.id, reviewChangeId: reviewChangeId, clientActionId: clientActionId);
  } else {
    final file = await ref.read(dishPhotoPickerProvider)(source == _Source.camera ? ImageSource.camera : ImageSource.gallery);
    if (file == null || !context.mounted) return false;
    final bytes = await file.readAsBytes();
    if (!context.mounted) return false;
    if (!await _confirm(context, dishName, Image.memory(bytes, fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox()))) {
      return false;
    }
    send = () => repo.replacePhotoUpload(productId, file, reviewChangeId: reviewChangeId, clientActionId: clientActionId);
  }
  if (!context.mounted) return false;
  return _send(context, ref, send);
}

Future<bool> _confirm(BuildContext context, String dishName, Widget preview) async =>
    await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text('Use this photo for $dishName?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ClipRRect(borderRadius: BorderRadius.circular(12), child: SizedBox(width: 220, height: 220, child: preview)),
            const SizedBox(height: 12),
            const Text('Customers see it straight away. The shop is told Deligro replaced the photo.'),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(key: const Key('replace-confirm'), onPressed: () => Navigator.pop(ctx, true), child: const Text('Use photo')),
        ],
      ),
    ) ??
    false;

/// One send; a fault offers Retry with the same id, so a retry never replaces twice.
Future<bool> _send(BuildContext context, WidgetRef ref, Future<Outcome<ProductDetail>> Function() send) async {
  final Outcome<ProductDetail> out;
  try {
    out = await send();
  } on ApiException catch (e) {
    if (e.unauthorized) {
      await handleUnauthorized(ref, e);
      return false;
    }
    if (!context.mounted) return false;
    final retried = Completer<bool>();
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text(e.friendly),
        action: SnackBarAction(label: 'Retry', onPressed: () async => retried.complete(await _send(context, ref, send))),
      )).closed.then((reason) {
        if (reason != SnackBarClosedReason.action && !retried.isCompleted) retried.complete(false);
      });
    return retried.future;
  }
  if (!context.mounted) return out is Applied;
  switch (out) {
    case Applied():
      showSnack(context, 'Photo replaced. The shop has been told.');
      return true;
    case Refused(:final code):
      showSnack(
        context,
        switch (code) {
          'bad_file' => 'That photo could not be used. Use a JPEG, PNG or WebP under 2 MB.',
          'not_found' => "This dish isn't in your zones.",
          'permission_denied' || 'forbidden' => "You don't have permission to replace photos. Ask an admin.",
          'rate_limited' => 'Too many changes at once. Wait a moment and try again.',
          _ => "That didn't go through ($code).",
        },
      );
      return false;
  }
}

/// The Deligro photo library: best matches for the dish first, or a search.
class _LibraryPicker extends ConsumerStatefulWidget {
  const _LibraryPicker({required this.productId, required this.dishName});
  final String productId;
  final String dishName;

  @override
  ConsumerState<_LibraryPicker> createState() => _LibraryPickerState();
}

class _LibraryPickerState extends ConsumerState<_LibraryPicker> {
  late Future<List<LibraryPhoto>> _photos = _load(null);
  Timer? _debounce;

  Future<List<LibraryPhoto>> _load(String? q) => ref.read(productsRepoProvider).photoSuggestions(widget.productId, q: q);

  void _search(String text) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () {
      final q = text.trim();
      if (!mounted) return;
      setState(() {
        _photos = _load(q.isEmpty ? null : q);
      });
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Deligro photo library'), backgroundColor: c.bg),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: TextField(
              key: const Key('library-search'),
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                hintText: 'Search photos (best matches for ${widget.dishName} shown)',
                border: const OutlineInputBorder(),
              ),
              onChanged: _search,
            ),
          ),
          Expanded(
            child: FutureBuilder<List<LibraryPhoto>>(
              future: _photos,
              builder: (context, snap) {
                if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
                if (snap.hasError) {
                  return Center(child: Text('Could not load the library. Try again.', style: TextStyle(color: c.deal)));
                }
                final list = snap.data ?? const <LibraryPhoto>[];
                if (list.isEmpty) return Center(child: Text('No photos found. Try another word.', style: TextStyle(color: c.muted)));
                return GridView.builder(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                  gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                    maxCrossAxisExtent: 180,
                    mainAxisSpacing: 10,
                    crossAxisSpacing: 10,
                    childAspectRatio: .8,
                  ),
                  itemCount: list.length,
                  itemBuilder: (context, i) {
                    final p = list[i];
                    return InkWell(
                      key: Key('library-photo-${p.id}'),
                      borderRadius: BorderRadius.circular(12),
                      onTap: () => Navigator.pop(context, p),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(child: LayoutBuilder(builder: (_, box) => ProductThumb(url: p.imageUrl, size: box.maxWidth))),
                          const SizedBox(height: 4),
                          Text(p.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
                        ],
                      ),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
