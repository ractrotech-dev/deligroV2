import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'prefs.dart';
import '../core/ring.dart' show boardRingerProvider;
import 'providers.dart';
import 'safety.dart' show sosQueueProvider;

/// Things kept on the phone for the signed-in rider only: their emergency
/// contact and their notification switches. Each is stored under their user
/// id, so another rider on the same phone never reads them, and anything
/// stored for someone else is deleted as soon as the signed-in user changes.
const personalKeys = ['emergency_contact_v1', 'notification_prefs_v1'];

/// The prefs key of [base] for [uid].
String userKey(String base, String uid) => '$base:$uid';

String? readUserString(SharedPreferences prefs, String base, String? uid) =>
    uid == null ? null : prefs.getString(userKey(base, uid));

Future<void> writeUserString(SharedPreferences prefs, String base, String? uid, String value) async {
  if (uid == null) return;
  await prefs.setString(userKey(base, uid), value);
}

Future<void> removeUserString(SharedPreferences prefs, String base, String? uid) async {
  if (uid == null) return;
  await prefs.remove(userKey(base, uid));
}

/// Deletes every personal item that is not [keepUid]'s (all of them when it is
/// null, after a sign-out), and the unkeyed copies an earlier build made.
Future<void> purgeOtherUsers(SharedPreferences prefs, String? keepUid) async {
  for (final k in prefs.getKeys().toList()) {
    for (final base in personalKeys) {
      final own = keepUid != null && k == userKey(base, keepUid);
      if ((k == base || k.startsWith('$base:')) && !own) {
        await prefs.remove(k);
      }
    }
  }
}

/// Where the app keeps files: its documents folder (kept proof photos, under
/// `proof/`) and its cache folder (what the share sheet and the PDF plugin
/// leave behind). Tests replace it.
typedef AppDirs = ({Directory documents, Directory cache});

final appDirsProvider = Provider<Future<AppDirs>>(
  (_) async => (documents: await getApplicationDocumentsDirectory(), cache: await getTemporaryDirectory()),
);

String _norm(String path) => File(path).absolute.path.replaceAll('\\', '/');

/// Deletes the kept proof photos (`proof/` in the documents folder) that no
/// saved delivery step needs any more. [keep] are the photos saved steps still
/// carry, whoever's they are: a step another rider left on this phone keeps
/// its photo until it is sent in their session.
Future<void> sweepProofPhotos(Directory documents, Iterable<String> keep) async {
  final dir = Directory('${documents.path}/proof');
  if (!await dir.exists()) return;
  final wanted = {for (final k in keep) _norm(k)};
  await for (final f in dir.list()) {
    if (f is File && !wanted.contains(_norm(f.path))) {
      try {
        await f.delete();
      } catch (_) {}
    }
  }
}

/// A folder share_plus makes for a file shared from memory: a UUID v4.
final _uuidDir = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

/// Deletes what sharing and printing left in the cache folder: share_plus's
/// `share_plus/` and its per-file UUID folders (the statement CSV), the PDF
/// plugin's `share/` and `printing*` files (the statement PDF), and photos
/// image_picker left there (proof, receipt and document shots).
Future<void> clearShareCaches(Directory cache) async {
  if (!await cache.exists()) return;
  await for (final e in cache.list()) {
    final name = e.uri.pathSegments.where((s) => s.isNotEmpty).lastOrNull ?? '';
    final drop = e is Directory
        ? (name == 'share_plus' || name == 'share' || _uuidDir.hasMatch(name))
        : (name.startsWith('printing') || name.startsWith('image_picker') || name.startsWith('scaled_'));
    if (!drop) continue;
    try {
      await e.delete(recursive: true);
    } catch (_) {}
  }
}

/// The proof photos the saved delivery steps still carry, every rider's.
/// Null when the queue cannot be read: then nothing is deleted.
Set<String>? _keptPhotos(Ref ref) {
  try {
    return {for (final a in ref.read(actionQueueProvider).all) ?a.localPhoto};
  } catch (_) {
    return null;
  }
}

Future<void> _onSignedOut(Ref ref) async {
  // Ruling P7-R3: an alert waiting to be sent goes with its rider's session.
  // The SOS queue hears a user change only while something listens to it, so
  // it is told here too (a cold start into Jobs never built Home's listener).
  try {
    await ref.read(sosQueueProvider).userChanged(null);
  } catch (_) {}
  // An offer held for the rider who left must not keep ringing.
  try {
    await ref.read(boardRingerProvider.notifier).stopAll();
  } catch (_) {}
  try {
    await ref.read(activeCacheProvider).clear();
  } catch (_) {}
  final keep = _keptPhotos(ref);
  try {
    final dirs = await ref.read(appDirsProvider);
    if (keep != null) await sweepProofPhotos(dirs.documents, keep);
    await clearShareCaches(dirs.cache);
  } catch (e) {
    debugPrint('sign-out clean-up: $e');
  }
}

Future<void> _sweepAtStart(Ref ref) async {
  final keep = _keptPhotos(ref);
  if (keep == null) return;
  try {
    await sweepProofPhotos((await ref.read(appDirsProvider)).documents, keep);
  } catch (e) {
    debugPrint('proof photo sweep: $e');
  }
}

/// Keeps what is on the phone to the signed-in rider. When it starts and
/// whenever the user changes, the personal items of anyone else are deleted
/// and the proof photos no saved step needs are swept. On sign-out it also
/// lets go of the delivery kept for no signal, and of what sharing and
/// printing left in the cache. Watch it for the app's life (the app does).
final userDataGuardProvider = Provider<void>((ref) {
  final prefs = ref.read(prefsProvider);
  ref.listen<String?>(userIdProvider, (prev, uid) {
    unawaited(purgeOtherUsers(prefs, uid));
    if (uid == null && prev != null) unawaited(_onSignedOut(ref));
  });
  unawaited(purgeOtherUsers(prefs, ref.read(userIdProvider)));
  unawaited(_sweepAtStart(ref));
});
