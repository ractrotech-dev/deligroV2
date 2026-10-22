import 'dart:io';
import 'dart:typed_data';

/// A document the rider chose to upload, as the upload screen sees it. [head]
/// is the file's first bytes, read when it was picked, so the type can be
/// checked on the phone before anything is sent.
class PickedDocument {
  const PickedDocument({
    required this.path,
    required this.name,
    required this.size,
    required this.head,
    this.temporary = false,
  });

  final String path;
  final String name;
  final int size;
  final Uint8List head;

  /// A copy the app made (a camera shot, the file picker's cache copy): it is
  /// deleted once sent or abandoned. Never true for a file the rider owns.
  final bool temporary;

  /// `application/pdf`, `image/jpeg`, `image/png`, or null for anything else
  /// (a video renamed `.pdf` has no PDF header).
  String? get mime => sniffDocumentMime(head);
}

/// The server's limit (`DOC_MAX_BYTES`): 10 MB.
const documentMaxBytes = 10 * 1024 * 1024;

/// What the app actually sends: the hosting may cut a request body off near
/// 4.5 MB, so a photo is shrunk to this and a PDF over it is refused.
const documentUploadMaxBytes = 4 * 1024 * 1024;

/// What the first bytes say the file is. The same three types the server
/// accepts, by their magic bytes; the name is never trusted.
String? sniffDocumentMime(List<int> head) {
  bool starts(List<int> sig) {
    if (head.length < sig.length) return false;
    for (var i = 0; i < sig.length; i++) {
      if (head[i] != sig[i]) return false;
    }
    return true;
  }

  if (starts(const [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (starts(const [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (starts(const [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
  return null;
}

/// Why a picked file cannot be sent, as the server's error code (so the same
/// words show), or null when it can. Size first, as the server does. A photo
/// between 4 and 10 MB passes: it is shrunk before it is sent. A PDF cannot
/// be shrunk, so over 4 MB it is `pdf_too_large`.
String? checkPickedDocument(PickedDocument f) {
  if (f.size > documentMaxBytes) return 'too_large';
  if (f.size <= 0 || f.mime == null) return 'bad_type';
  if (f.mime == 'application/pdf' && f.size > documentUploadMaxBytes) return 'pdf_too_large';
  return null;
}

/// Reads the first bytes of a file for [PickedDocument.head].
Future<Uint8List> readHead(String path, {int count = 16}) async {
  final f = await File(path).open();
  try {
    return await f.read(count);
  } finally {
    await f.close();
  }
}

/// Removes a picked or captured copy once it is uploaded (or given up on).
Future<void> deleteQuietly(String path) async {
  try {
    final f = File(path);
    if (await f.exists()) await f.delete();
  } catch (_) {
    // A cache file the phone will clear anyway.
  }
}
