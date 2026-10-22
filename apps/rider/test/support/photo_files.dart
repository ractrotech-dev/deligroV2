import 'dart:io';

/// A real file on disk for a photo test. By default its first bytes are those
/// of the type its name says (JPEG, PNG; anything else gets a PDF header), so
/// the app's check of the bytes passes or fails on purpose.
File testPhoto(String name, {List<int>? bytes}) {
  final lower = name.toLowerCase();
  final head = bytes ??
      (lower.endsWith('.png')
          ? [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]
          : lower.endsWith('.jpg') || lower.endsWith('.jpeg')
              ? [0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 0x4A, 0x46, 0x49, 0x46, 0, 1]
              : '%PDF-1.4\n'.codeUnits);
  final dir = Directory('${Directory.systemTemp.path}/p7a_photos')..createSync(recursive: true);
  final f = File('${dir.path}/$name');
  f.writeAsBytesSync(head);
  return f;
}
