import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:printing/printing.dart';

import '../core/document_file.dart';
import '../core/image_shrink.dart';
import '../data/fixtures/fixture_backend.dart';
import '../data/fixtures/fixture_profile.dart';
import '../data/profile_repository.dart';
import '../models/profile.dart';
import 'providers.dart';

/// The profile routes, or in a debug build started with FIXTURES=true the
/// in-memory fixture backend. `fixturesEnabled` is a compile-time false in a
/// release build, so the fixture branch (and its data) is not in the app.
final profileRepoProvider = Provider<ProfileRepository>((ref) {
  if (fixturesEnabled) return FixtureProfileRepository.create();
  return ApiProfileRepository(ref.watch(apiProvider));
});

/// The Profile & documents pages' data, for one rider (keyed by
/// [riderKeyProvider]). Dropped when the pages are left, so coming back asks
/// again.
final riderProfileProvider = FutureProvider.autoDispose.family<RiderProfile, String>(
  retry: (_, _) => null,
  (ref, riderKey) => ref.watch(profileRepoProvider).profile(),
);

/// Deligro's answers to the rider's earlier requests.
final changeRequestsProvider = FutureProvider.autoDispose.family<List<ChangeRequestView>, String>(
  retry: (_, _) => null,
  (ref, riderKey) => ref.watch(profileRepoProvider).changeRequests(),
);

/// Re-reads everything a saved change can affect: the pages, and `/me` (the
/// Home badge and the red dot on More). Takes the container, not a
/// `WidgetRef`, so a screen can capture it before an `await` and still refresh
/// after the rider has gone back (a `WidgetRef` is dead once its widget is).
void refreshProfileIn(ProviderContainer container) {
  container.invalidate(riderProfileProvider);
  container.invalidate(changeRequestsProvider);
  container.invalidate(meProvider);
}

void refreshProfile(WidgetRef ref) => refreshProfileIn(ProviderScope.containerOf(ref.context, listen: false));

/// Whether profile writes are allowed: `driver.profile_edit`, switched per rider.
const profileEditFeature = 'driver.profile_edit';

// ---------- Picking files ----------

enum DocSource { camera, file }

/// Asks the rider for a document: the camera, or a PDF/JPEG/PNG from the phone.
/// Null when they backed out. Tests replace it: there is no camera or file
/// browser in a widget test.
typedef DocumentChooser = Future<PickedDocument?> Function(DocSource source);

Future<PickedDocument?> _chooseDocument(DocSource source) async {
  if (source == DocSource.camera) {
    final shot = await ImagePicker().pickImage(
      source: ImageSource.camera,
      imageQuality: 85,
      maxWidth: 2400,
      maxHeight: 2400,
    );
    if (shot == null) return null;
    final size = await File(shot.path).length();
    return PickedDocument(
      path: shot.path,
      name: shot.name,
      size: size,
      head: await readHead(shot.path),
      temporary: true,
    );
  }
  final picked = await FilePicker.pickFile(
    type: FileType.custom,
    allowedExtensions: const ['pdf', 'jpg', 'jpeg', 'png'],
  );
  final path = picked?.path;
  if (picked == null || path == null) return null;
  return PickedDocument(
    path: path,
    name: picked.name,
    size: await File(path).length(),
    head: await readHead(path),
    // The picker hands over a copy in its own cache folder; delete only that.
    temporary: path.contains('file_picker'),
  );
}

final documentChooserProvider = Provider<DocumentChooser>((_) => _chooseDocument);

/// The profile photo: the camera (`true`) or the gallery. Null when backed out.
typedef AvatarChooser = Future<File?> Function({required bool camera});

Future<File?> _chooseAvatar({required bool camera}) async {
  final shot = await ImagePicker().pickImage(
    source: camera ? ImageSource.camera : ImageSource.gallery,
    imageQuality: 85,
    maxWidth: 1200,
    maxHeight: 1200,
    preferredCameraDevice: CameraDevice.front,
  );
  return shot == null ? null : File(shot.path);
}

final avatarChooserProvider = Provider<AvatarChooser>((_) => _chooseAvatar);

/// The viewer draws this many pages of a PDF; the rasterizer is asked for one
/// more so the viewer can say there are others.
const pdfPagesShown = 8;

/// A PDF's first pages as PNGs ([pdfPagesShown] + 1 at most), for the document
/// viewer. Tests replace it. The printing plugin does this work, and it
/// writes the PDF to the phone's cache briefly while it does.
typedef PdfRasterizer = Future<List<Uint8List>> Function(Uint8List pdf);

Future<List<Uint8List>> _rasterize(Uint8List pdf) async {
  final pages = <Uint8List>[];
  await for (final page in Printing.raster(pdf, dpi: 110)) {
    pages.add(await page.toPng());
    if (pages.length > pdfPagesShown) break;
  }
  return pages;
}

final pdfRasterizerProvider = Provider<PdfRasterizer>((_) => _rasterize);

/// Shrinks a big photo before it is sent. Tests replace it.
final documentShrinkerProvider = Provider<DocumentShrinker>((_) => shrinkPickedDocument);
