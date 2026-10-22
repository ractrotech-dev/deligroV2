import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;
import 'package:path_provider/path_provider.dart';

import 'document_file.dart';

/// Makes a photo small enough to send: JPEG, at most [maxBytes], by lowering
/// the quality and then the size until it fits. Returns null when even the
/// smallest try is too big (a photo that cannot be decoded, say).
Uint8List? shrinkToJpeg(Uint8List bytes, {int maxBytes = documentUploadMaxBytes}) {
  final decoded = img.decodeImage(bytes);
  if (decoded == null) return null;
  for (final longSide in const [2400, 2000, 1600, 1280, 1024]) {
    final scaled = decoded.width >= decoded.height
        ? (decoded.width > longSide ? img.copyResize(decoded, width: longSide) : decoded)
        : (decoded.height > longSide ? img.copyResize(decoded, height: longSide) : decoded);
    for (final quality in const [85, 75, 65, 55]) {
      final out = Uint8List.fromList(img.encodeJpg(scaled, quality: quality));
      if (out.length <= maxBytes) return out;
    }
  }
  return null;
}

/// Turns a picked document into one that can be sent: a PDF or a photo that is
/// already small is returned as it is; a bigger photo becomes a JPEG copy
/// (marked [PickedDocument.temporary], so it is deleted after). Throws
/// [UnshrinkableException] when it cannot be made to fit.
typedef DocumentShrinker = Future<PickedDocument> Function(PickedDocument file);

class UnshrinkableException implements Exception {
  const UnshrinkableException();
}

Future<PickedDocument> shrinkPickedDocument(PickedDocument file) async {
  if (file.mime == 'application/pdf' || file.size <= documentUploadMaxBytes) return file;
  final bytes = await File(file.path).readAsBytes();
  final small = await compute(_shrink, bytes);
  if (small == null) throw const UnshrinkableException();
  final dir = await getTemporaryDirectory();
  final out = File('${dir.path}/doc-${DateTime.now().microsecondsSinceEpoch}.jpg');
  await out.writeAsBytes(small, flush: true);
  return PickedDocument(
    path: out.path,
    name: '${file.name.replaceFirst(RegExp(r'\.[^.]+$'), '')}.jpg',
    size: small.length,
    head: Uint8List.fromList(small.sublist(0, 16)),
    temporary: true,
  );
}

Uint8List? _shrink(Uint8List bytes) => shrinkToJpeg(bytes);
