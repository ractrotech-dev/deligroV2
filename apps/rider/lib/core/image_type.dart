import 'dart:io';

import 'package:http_parser/http_parser.dart' show MediaType;

/// The two photo types the support routes take.
enum PhotoType {
  jpeg('image', 'jpeg'),
  png('image', 'png');

  const PhotoType(this.type, this.subtype);

  final String type;
  final String subtype;

  MediaType get mediaType => MediaType(type, subtype);
}

/// The type a photo really is, from its first bytes (JPEG `FF D8 FF`, PNG
/// `89 50 4E 47 0D 0A 1A 0A`), never from its file name. Null for anything else.
PhotoType? sniffImageBytes(List<int> b) {
  if (b.length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return PhotoType.jpeg;
  const png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (b.length >= png.length) {
    var same = true;
    for (var i = 0; i < png.length; i++) {
      if (b[i] != png[i]) {
        same = false;
        break;
      }
    }
    if (same) return PhotoType.png;
  }
  return null;
}

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
