import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../theme/app_theme.dart';
import '../delivery/proof_photo.dart' show photoTakerProvider;

/// The most photos one message can carry.
const maxPhotos = 4;

/// The biggest photo the server takes.
const maxPhotoBytes = 5 * 1024 * 1024;

/// Picks photos from the gallery, at most [limit]; empty when the rider backed out.
typedef GalleryPicker = Future<List<File>> Function(int limit);

Future<List<File>> _pickFromGallery(int limit) async {
  final picker = ImagePicker();
  if (limit <= 1) {
    final one = await picker.pickImage(
      source: ImageSource.gallery,
      imageQuality: 80,
      maxWidth: 1600,
      maxHeight: 1600,
    );
    return one == null ? const [] : [File(one.path)];
  }
  final many = await picker.pickMultiImage(
    limit: limit,
    imageQuality: 80,
    maxWidth: 1600,
    maxHeight: 1600,
  );
  return [for (final m in many) File(m.path)];
}

/// Tests replace it: there is no gallery in a widget test.
final galleryPickerProvider = Provider<GalleryPicker>((_) => _pickFromGallery);

/// Why a photo cannot go (the server takes JPEG and PNG up to 5 MB), or null.
String? photoProblem(File f) {
  final name = f.path.toLowerCase();
  if (!(name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png'))) {
    return 'Only JPEG or PNG photos can be sent.';
  }
  try {
    if (f.lengthSync() > maxPhotoBytes) return 'A photo is over 5 MB. Choose a smaller one.';
  } catch (_) {
    // Cannot be read here: the server has the last word.
  }
  return null;
}

/// Up to four photos on a message: thumbnails with a remove button, and Add
/// photo (camera or gallery) while there is room.
class PhotoAttachments extends ConsumerStatefulWidget {
  const PhotoAttachments({super.key, required this.photos, required this.onChanged, this.compact = false});

  final List<File> photos;
  final ValueChanged<List<File>> onChanged;

  /// An icon button instead of the full-width Add photo button (a reply bar).
  final bool compact;

  @override
  ConsumerState<PhotoAttachments> createState() => _PhotoAttachmentsState();
}

class _PhotoAttachmentsState extends ConsumerState<PhotoAttachments> {
  String? _note;

  void _add(List<File> picked) {
    final room = maxPhotos - widget.photos.length;
    final next = [...widget.photos];
    String? note;
    for (final f in picked) {
      final problem = photoProblem(f);
      if (problem != null) {
        note = problem;
        continue;
      }
      if (next.length >= maxPhotos) {
        note = 'Only $maxPhotos photos can be attached.';
        continue;
      }
      next.add(f);
    }
    if (picked.length > room && note == null) note = 'Only $maxPhotos photos can be attached.';
    setState(() => _note = note);
    widget.onChanged(next);
  }

  Future<void> _choose() async {
    if (widget.photos.length >= maxPhotos) {
      setState(() => _note = 'Only $maxPhotos photos can be attached.');
      return;
    }
    final source = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              key: const Key('photo-camera'),
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('Take a photo'),
              onTap: () => Navigator.pop(sheet, 'camera'),
            ),
            ListTile(
              key: const Key('photo-gallery'),
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('Choose from gallery'),
              onTap: () => Navigator.pop(sheet, 'gallery'),
            ),
          ],
        ),
      ),
    );
    if (source == null || !mounted) return;
    try {
      if (source == 'camera') {
        final shot = await ref.read(photoTakerProvider)();
        if (shot != null && mounted) _add([shot]);
      } else {
        final picked = await ref.read(galleryPickerProvider)(maxPhotos - widget.photos.length);
        if (picked.isNotEmpty && mounted) _add(picked);
      }
    } catch (_) {
      if (mounted) setState(() => _note = "Couldn't open the camera or gallery.");
    }
  }

  void _remove(int i) {
    final next = [...widget.photos]..removeAt(i);
    setState(() => _note = null);
    widget.onChanged(next);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final full = widget.photos.length >= maxPhotos;
    if (widget.compact) {
      return IconButton(
        key: const Key('add-photo'),
        tooltip: 'Add photo',
        onPressed: _choose,
        icon: Badge(
          isLabelVisible: widget.photos.isNotEmpty,
          label: Text('${widget.photos.length}'),
          child: const Icon(Icons.photo_camera_outlined),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (widget.photos.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                for (var i = 0; i < widget.photos.length; i++)
                  _Thumb(key: Key('photo-$i'), file: widget.photos[i], onRemove: () => _remove(i)),
              ],
            ),
          ),
        OutlinedButton.icon(
          key: const Key('add-photo'),
          onPressed: full ? null : _choose,
          icon: const Icon(Icons.add_a_photo_outlined, size: 20),
          label: Text(full ? '$maxPhotos of $maxPhotos photos added' : 'Add photo (up to $maxPhotos)'),
        ),
        if (_note != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              _note!,
              key: const Key('photo-note'),
              style: TextStyle(color: c.deal, fontWeight: FontWeight.w600, fontSize: 13.5),
            ),
          ),
      ],
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({super.key, required this.file, required this.onRemove});

  final File file;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SizedBox(
      width: 72,
      height: 72,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned.fill(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: Image.file(
                file,
                fit: BoxFit.cover,
                cacheWidth: 216,
                errorBuilder: (_, _, _) =>
                    ColoredBox(color: c.surface2, child: Icon(Icons.image_outlined, color: c.muted)),
              ),
            ),
          ),
          Positioned(
            top: -8,
            right: -8,
            child: Semantics(
              button: true,
              label: 'Remove photo',
              child: InkWell(
                key: const Key('remove-photo'),
                onTap: onRemove,
                customBorder: const CircleBorder(),
                child: Container(
                  width: 28,
                  height: 28,
                  decoration: BoxDecoration(
                    color: c.ink,
                    shape: BoxShape.circle,
                    border: Border.all(color: c.bg, width: 2),
                  ),
                  child: Icon(Icons.close_rounded, size: 16, color: c.bg),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
