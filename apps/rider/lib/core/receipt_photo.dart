import 'dart:io';

import 'package:http_parser/http_parser.dart' show MediaType;

/// The most a receipt photo may weigh before it is sent (the server's own
/// limit is 5 MB with the form around it).
const receiptMaxBytes = 4 * 1024 * 1024;

/// What the rider is told about a photo that cannot go.
const receiptPhotoRefused =
    "This photo can't be used. Take a new photo of the receipt (JPEG or PNG, up to 4 MB).";

/// A receipt photo's real type, read from its first bytes: JPEG `FF D8 FF` or
/// PNG `89 50 4E 47`. The server compares the bytes with the type it is told
/// (`assertRealType`), and image_picker re-encodes a photo but keeps the old
/// file name, so the name can never be trusted. Null for anything else.
///
/// A small local helper; it is unified with P6's `sniffDocumentMime` at
/// integration.
MediaType? sniffReceiptType(List<int> head) {
  if (head.length >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF) {
    return MediaType('image', 'jpeg');
  }
  if (head.length >= 4 &&
      head[0] == 0x89 &&
      head[1] == 0x50 &&
      head[2] == 0x4E &&
      head[3] == 0x47) {
    return MediaType('image', 'png');
  }
  return null;
}

/// The type of the photo at [file], or null when it is not a JPEG or PNG, is
/// empty, is over [receiptMaxBytes], or cannot be read. Small and read once,
/// so it is done synchronously.
MediaType? receiptTypeOf(File file) {
  try {
    final size = file.lengthSync();
    if (size <= 0 || size > receiptMaxBytes) return null;
    final raf = file.openSync();
    try {
      return sniffReceiptType(raf.readSync(8));
    } finally {
      raf.closeSync();
    }
  } on FileSystemException {
    return null;
  }
}

/// Removes a picked photo from the phone's cache. Best effort.
void discardReceipt(File? file) {
  if (file == null) return;
  try {
    if (file.existsSync()) file.deleteSync();
  } on FileSystemException {
    // Nothing to do: the cache is emptied by the phone anyway.
  }
}
