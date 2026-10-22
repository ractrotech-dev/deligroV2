import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';

import '../../theme/app_theme.dart';

/// Opens the camera and returns the photo, or null when the rider backed out.
typedef PhotoTaker = Future<File?> Function();

/// The phone's camera through image_picker: a JPEG (quality 80), at most
/// 1600 px on the long side, which keeps an upload on a weak signal to a few
/// hundred KB. image_picker asks for the camera permission itself.
Future<File?> _takeWithCamera() async {
  final shot = await ImagePicker().pickImage(
    source: ImageSource.camera,
    imageQuality: 80,
    maxWidth: 1600,
    maxHeight: 1600,
    preferredCameraDevice: CameraDevice.rear,
  );
  return shot == null ? null : File(shot.path);
}

/// Tests replace it: there is no camera in a widget test.
final photoTakerProvider = Provider<PhotoTaker>((_) => _takeWithCamera);

/// Keeps a copy of the proof photo where it survives the app being closed,
/// for a delivery saved with no signal; returns the copy's path. The action
/// queue uploads it once the signal is back and deletes it after.
typedef ProofKeeper = Future<String> Function(String orderId, File photo);

/// The app's documents folder (`proof/`): image_picker's file lives in a
/// cache folder the phone may empty.
Future<String> _keepInDocuments(String orderId, File photo) async {
  final dir = Directory('${(await getApplicationDocumentsDirectory()).path}/proof');
  await dir.create(recursive: true);
  final ext = photo.path.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  final copy = await photo.copy('${dir.path}/$orderId-${DateTime.now().microsecondsSinceEpoch}.$ext');
  return copy.path;
}

/// Tests replace it: there is no documents folder in a widget test.
final proofKeeperProvider = Provider<ProofKeeper>((_) => _keepInDocuments);

/// Where the proof photo is: none yet, sending, on the server, or failed.
enum ProofState { none, uploading, attached, failed }

/// The one line the rider reads before taking the photo (ruling P8-R4, §7.5
/// privacy safeguard): the package is the proof, never a person.
const proofPhotoHint = 'Photograph the package at the door — not people.';

/// The photo step of the delivery panel. Before a photo: one big "Take proof
/// photo" with the privacy hint under it. After: the picture, its state, and
/// Retake.
class ProofPhotoTile extends StatelessWidget {
  const ProofPhotoTile({
    super.key,
    required this.state,
    required this.photo,
    required this.onTake,
    this.enabled = true,
  });

  final ProofState state;
  final File? photo;
  final VoidCallback onTake;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final file = photo;
    if (file == null || state == ProofState.none) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          OutlinedButton.icon(
            key: const Key('proof-photo'),
            onPressed: enabled ? onTake : null,
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(56),
              side: BorderSide(color: c.accent, width: 2),
              foregroundColor: c.accentInk,
            ),
            icon: const Icon(Icons.photo_camera_rounded, size: 24),
            label: const Text('1. Take proof photo'),
          ),
          const SizedBox(height: 6),
          Text(
            proofPhotoHint,
            key: const Key('proof-photo-hint'),
            textAlign: TextAlign.center,
            style: TextStyle(color: c.muted, fontSize: 13.5, fontWeight: FontWeight.w600),
          ),
        ],
      );
    }
    final (text, color, icon) = switch (state) {
      ProofState.uploading => ('Sending photo…', c.muted, Icons.cloud_upload_outlined),
      ProofState.failed => ("Photo not sent — it'll retry", c.deal, Icons.error_outline_rounded),
      _ => ('Photo attached', c.green, Icons.check_circle_rounded),
    };
    return Container(
      key: state == ProofState.attached ? const Key('proof-photo-attached') : const Key('proof-photo-pending'),
      padding: const EdgeInsets.all(6),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: state == ProofState.failed ? c.deal : c.line),
      ),
      child: Row(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: SizedBox(
              width: 44,
              height: 44,
              child: Image.file(
                file,
                fit: BoxFit.cover,
                cacheWidth: 132,
                errorBuilder: (_, _, _) => ColoredBox(color: c.surface2, child: Icon(Icons.image_outlined, color: c.muted)),
              ),
            ),
          ),
          const SizedBox(width: 10),
          Icon(icon, size: 20, color: color),
          const SizedBox(width: 6),
          Expanded(
            child: Text(text, style: TextStyle(color: color, fontWeight: FontWeight.w800, fontSize: 15)),
          ),
          TextButton(
            key: const Key('proof-retake'),
            onPressed: enabled && state != ProofState.uploading ? onTake : null,
            child: const Text('Retake'),
          ),
        ],
      ),
    );
  }
}
