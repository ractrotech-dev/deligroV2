import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/live.dart';
import '../widgets/zone_picker.dart';
import 'providers.dart';

/// How often Live re-asks while on screen (design: 10 s).
const liveRefresh = Duration(seconds: 10);

/// The live board for the zone on the picker (or all of this person's
/// zones). `refresh` keeps the last board on screen if a poll fails.
class LiveNotifier extends AsyncNotifier<LiveSnapshot> {
  @override
  Future<LiveSnapshot> build() async {
    ref.watch(signedInProvider);
    final zone = ref.watch(activeZoneProvider);
    return ref.read(liveRepoProvider).snapshot(zoneId: zone?.id);
  }

  Future<void> refresh() async {
    if (!state.hasValue) {
      ref.invalidateSelf();
      return;
    }
    final zone = ref.read(activeZoneProvider);
    final next = await AsyncValue.guard(() => ref.read(liveRepoProvider).snapshot(zoneId: zone?.id));
    if (next.hasValue) state = next;
  }
}

final liveSnapshotProvider = AsyncNotifierProvider.autoDispose<LiveNotifier, LiveSnapshot>(
  LiveNotifier.new,
  retry: (_, _) => null,
);
