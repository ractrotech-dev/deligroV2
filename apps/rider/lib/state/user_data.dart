import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'prefs.dart';
import 'providers.dart';

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

/// Keeps the personal items to the signed-in rider: purges when it starts and
/// whenever the user changes or signs out. Read it once (the shell does).
final userDataGuardProvider = Provider<void>((ref) {
  final prefs = ref.read(prefsProvider);
  ref.listen<String?>(userIdProvider, (_, uid) => purgeOtherUsers(prefs, uid));
  purgeOtherUsers(prefs, ref.read(userIdProvider));
});
