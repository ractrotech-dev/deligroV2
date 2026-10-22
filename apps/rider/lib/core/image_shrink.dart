import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:image/image.dart' as img;

import 'document_file.dart';

/// Makes a photo small enough to send: a JPEG of at most [maxBytes], by
/// lowering the size and then the quality until it fits. The phone's own
/// decoder does the first downsample (a 48-megapixel photo is never decoded
/// at full size in Dart, which would not fit in a low-end phone's memory);
/// only the smaller picture is JPEG-encoded, off the UI thread. Returns null
/// when it cannot be decoded or will not fit; throws [PhotoTooLargeException]
/// for a photo of more than about 50 megapixels.
Future<Uint8List?> shrinkToJpeg(Uint8List bytes, {int maxBytes = documentUploadMaxBytes}) async {
  final ui.ImmutableBuffer buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
  final ui.ImageDescriptor descriptor;
  try {
    descriptor = await ui.ImageDescriptor.encoded(buffer);
  } catch (_) {
    buffer.dispose();
    return null;
  }
  // Refused before anything is decoded: a 100-megapixel photo does not fit in
  // a low-end phone's memory.
  if (descriptor.width * descriptor.height > maxPhotoPixels) {
    descriptor.dispose();
    buffer.dispose();
    throw const PhotoTooLargeException();
  }
  try {
    final longest = math.max(descriptor.width, descriptor.height);
    for (final longSide in const [2400, 2000, 1600, 1280, 1024]) {
      final scale = math.min(1.0, longSide / longest);
      final ui.Codec codec = await descriptor.instantiateCodec(
        targetWidth: math.max(1, (descriptor.width * scale).round()),
        targetHeight: math.max(1, (descriptor.height * scale).round()),
      );
      final ui.Image image = (await codec.getNextFrame()).image;
      final ByteData? rgba = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      final width = image.width, height = image.height;
      image.dispose();
      codec.dispose();
      if (rgba == null) return null;
      final raw = rgba.buffer.asUint8List(rgba.offsetInBytes, rgba.lengthInBytes);
      for (final quality in const [85, 75, 65, 55]) {
        final out = await compute(_encode, (raw, width, height, quality));
        if (out.length <= maxBytes) return out;
      }
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    descriptor.dispose();
    buffer.dispose();
  }
}

Uint8List _encode((Uint8List, int, int, int) a) {
  final (rgba, width, height, quality) = a;
  final image = img.Image.fromBytes(
    width: width,
    height: height,
    bytes: rgba.buffer,
    bytesOffset: rgba.offsetInBytes,
    numChannels: 4,
    order: img.ChannelOrder.rgba,
  );
  return Uint8List.fromList(img.encodeJpg(image, quality: quality));
}

/// Turns a picked document into one that can be sent: a PDF or a photo that
/// is already small is returned as it is; a bigger photo becomes a JPEG held
/// in memory ([PickedDocument.bytes], never written to the phone). Throws
/// [UnshrinkableException] when it cannot be made to fit.
typedef DocumentShrinker = Future<PickedDocument> Function(PickedDocument file);

class UnshrinkableException implements Exception {
  const UnshrinkableException();
}

/// The photo has too many pixels to be opened safely (over about 50 megapixels).
class PhotoTooLargeException implements Exception {
  const PhotoTooLargeException();
}

Future<PickedDocument> shrinkPickedDocument(PickedDocument file) async {
  if (file.mime == 'application/pdf' || file.size <= documentUploadMaxBytes) return file;
  final small = await shrinkToJpeg(await File(file.path).readAsBytes());
  if (small == null) throw const UnshrinkableException();
  return PickedDocument(
    path: '',
    name: '${file.name.replaceFirst(RegExp(r'\.[^.]+$'), '')}.jpg',
    size: small.length,
    head: Uint8List.fromList(small.sublist(0, 16)),
    bytes: small,
  );
}
