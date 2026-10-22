import 'dart:io';

import 'package:http_parser/http_parser.dart' show MediaType;

import 'document_file.dart' show sniffDocumentMime;

/// The most a receipt photo may weigh before it is sent (the server's own
/// limit is 5 MB with the form around it).
const receiptMaxBytes = 4 * 1024 * 1024;

/// What the rider is told about a photo that cannot go.
const receiptPhotoRefused =
    "This photo can't be used. Take a new photo of the receipt (JPEG or PNG, up to 4 MB).";

/// A receipt photo's real type: the first bytes read by [sniffDocumentMime],
/// kept to JPEG and PNG (a PDF is a fine document but not a receipt photo).
/// The server compares the bytes with the type it is told (`assertRealType`),
/// and image_picker re-encodes a photo but keeps the old file name, so the
/// name can never be trusted. Null for anything else.
MediaType? sniffReceiptType(List<int> head) => switch (sniffDocumentMime(head)) {
  'image/jpeg' => MediaType('image', 'jpeg'),
  'image/png' => MediaType('image', 'png'),
  _ => null,
};

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
