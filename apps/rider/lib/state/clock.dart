import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The phone's "now", for anything that is the phone's own (the availability
/// window, a break). A test can move time by hand.
final clockProvider = Provider<DateTime Function()>((_) => DateTime.now);

/// How far the phone's clock is from the server's: `serverNow - phone now`,
/// worked out on each board (`serverNow` in `GET /api/rider/board`) at the
/// moment it arrives. Zero until a board has said. A phone whose clock is three
/// minutes fast has an offset of minus three minutes.
class ServerOffset extends Notifier<Duration> {
  @override
  Duration build() => Duration.zero;

  void set(Duration offset) => state = offset;
}

final serverOffsetProvider = NotifierProvider<ServerOffset, Duration>(ServerOffset.new);

/// "Now" on the server's clock: the phone's clock plus [serverOffsetProvider].
/// Everything counted against a server instant (the offer window, the held
/// flag, the board's ring) uses this, so a wrong phone clock cannot cut an
/// offer short or stretch it.
final serverClockProvider = Provider<DateTime Function()>((ref) {
  final clock = ref.watch(clockProvider);
  final offset = ref.watch(serverOffsetProvider);
  return () => clock().add(offset);
});
