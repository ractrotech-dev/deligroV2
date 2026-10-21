import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/rider_me.dart';
import 'providers.dart';

/// Where the rider stands in a shift. The server computes the same thing
/// (`riderPhase` in src/lib/rider/availability.ts); the app recomputes it from
/// the availability row so the chip follows the clock (a break running out, a
/// fix going stale) without asking the server.
enum RiderPhase { offline, online, onBreak, stale }

/// A fix older than this takes an online rider out of dispatch
/// (`RIDER_PRESENCE_MS` on the server).
const riderPresence = Duration(minutes: 5);

/// "Until I resume" is stored as a break that ends in year 9999
/// (`BREAK_UNTIL_RESUMED`). It is never shown as a date.
bool isUntilResumed(DateTime? breakUntil) =>
    breakUntil != null && breakUntil.year >= 9999;

RiderPhase phaseOf(RiderAvailabilityDto a, DateTime now) {
  if (!a.isOnline) return RiderPhase.offline;
  final until = a.breakUntil;
  if (until != null && until.isAfter(now)) return RiderPhase.onBreak;
  final fix = a.lastFixAt;
  final fresh = fix != null && now.difference(fix).abs() < riderPresence;
  return fresh ? RiderPhase.online : RiderPhase.stale;
}

/// The rider's availability row. Starts from `/api/rider/me` and follows it
/// whenever it is re-read; the four actions replace it with the server's
/// answer. A refused action throws the [ApiException] and leaves the state as
/// it was, so a switch that was refused stays where it was.
class AvailabilityNotifier extends Notifier<RiderAvailabilityDto> {
  @override
  RiderAvailabilityDto build() =>
      ref.watch(meProvider.select((m) => m.value?.availability)) ??
      RiderAvailabilityDto.offline;

  Future<void> _set(String action, {int? minutes}) async {
    state = await ref
        .read(riderRepoProvider)
        .setStatus(action, minutes: minutes);
  }

  Future<void> goOnline() => _set('online');

  Future<void> goOffline() => _set('offline');

  /// [minutes] is 15, 30 or 60; null is "until I resume".
  Future<void> takeBreak(int? minutes) => _set('break', minutes: minutes);

  Future<void> resume() => _set('resume');
}

final availabilityProvider =
    NotifierProvider<AvailabilityNotifier, RiderAvailabilityDto>(
      AvailabilityNotifier.new,
    );
