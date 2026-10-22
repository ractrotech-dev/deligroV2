import 'dart:io';

import 'package:http_parser/http_parser.dart' show MediaType;

import 'document_file.dart' show sniffDocumentMime;

/// The two photo types the support routes take.
enum PhotoType {
  jpeg('image', 'jpeg'),
  png('image', 'png');

  const PhotoType(this.type, this.subtype);

  final String type;
  final String subtype;

  MediaType get mediaType => MediaType(type, subtype);
}

/// The type a photo really is, from its first bytes, never from its file
/// name: [sniffDocumentMime] kept to JPEG and PNG (a PDF is a document, not a
/// photo). Null for anything else.
PhotoType? sniffImageBytes(List<int> b) => switch (sniffDocumentMime(b)) {
      'image/jpeg' => PhotoType.jpeg,
      'image/png' => PhotoType.png,
      _ => null,
    };

/// [sniffImageBytes] for a file on the phone; null when it cannot be read.
PhotoType? sniffImageFile(File f) {
  RandomAccessFile? raf;
  try {
    raf = f.openSync();
    return sniffImageBytes(raf.readSync(8));
  } catch (_) {
    return null;
  } finally {
    raf?.closeSync();
  }
}
