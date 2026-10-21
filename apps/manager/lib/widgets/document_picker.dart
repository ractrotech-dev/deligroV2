import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

/// The document types the server accepts (jpeg / png / webp / pdf, ≤ 10 MB).
const documentExtensions = ['jpg', 'jpeg', 'png', 'webp', 'pdf'];
const documentMaxBytes = 10 * 1024 * 1024;

/// Asks for a file or a photo. One seam so tests can hand back a file.
final documentPickerProvider = Provider<Future<XFile?> Function(BuildContext)>((_) => pickDocument);

Future<XFile?> pickDocument(BuildContext context) async {
  final source = await showModalBottomSheet<String>(
    context: context,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            leading: const Icon(Icons.photo_camera_outlined),
            title: const Text('Take a photo'),
            onTap: () => Navigator.pop(ctx, 'camera'),
          ),
          ListTile(
            leading: const Icon(Icons.upload_file_outlined),
            title: const Text('Choose a file'),
            subtitle: const Text('JPEG, PNG, WebP or PDF, up to 10 MB'),
            onTap: () => Navigator.pop(ctx, 'file'),
          ),
        ],
      ),
    ),
  );
  if (source == 'camera') {
    return ImagePicker().pickImage(source: ImageSource.camera, imageQuality: 80, maxWidth: 2400);
  }
  if (source == 'file') {
    final f = await FilePicker.pickFile(type: FileType.custom, allowedExtensions: documentExtensions);
    if (f == null) return null;
    final path = f.path;
    // A content:// file without a path is read into memory instead.
    return path != null ? XFile(path, name: f.name) : XFile.fromData(await f.readAsBytes(), name: f.name);
  }
  return null;
}

/// Why a picked file cannot be sent, or null.
Future<String?> documentFileProblem(XFile f) async {
  final ext = f.name.split('.').last.toLowerCase();
  if (!documentExtensions.contains(ext)) return 'Use a JPEG, PNG, WebP or PDF file.';
  if (await f.length() > documentMaxBytes) return 'That file is over 10 MB.';
  return null;
}
