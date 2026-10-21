import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/rider.dart';
import 'prefs.dart';

/// Where an unfinished rider onboarding is kept on the phone until it is
/// submitted or discarded. Never holds the password.
const riderOnboardDraftKey = 'manager-rider-onboard-draft';

class RiderOnboardDraftNotifier extends Notifier<RiderOnboardDraft> {
  @override
  RiderOnboardDraft build() {
    final raw = ref.read(prefsProvider).getString(riderOnboardDraftKey);
    if (raw == null) return const RiderOnboardDraft();
    try {
      return RiderOnboardDraft.fromJson((jsonDecode(raw) as Map).cast<String, dynamic>());
    } catch (_) {
      return const RiderOnboardDraft();
    }
  }

  void update(RiderOnboardDraft next) {
    state = next;
    ref.read(prefsProvider).setString(riderOnboardDraftKey, jsonEncode(next.toSaved()));
  }

  void clear() {
    state = const RiderOnboardDraft();
    ref.read(prefsProvider).remove(riderOnboardDraftKey);
  }
}

final riderOnboardDraftProvider =
    NotifierProvider<RiderOnboardDraftNotifier, RiderOnboardDraft>(RiderOnboardDraftNotifier.new);
