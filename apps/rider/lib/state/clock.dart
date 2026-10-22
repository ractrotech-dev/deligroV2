import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The phone's "now", for anything that is the phone's own (the availability
/// window, a break). A test can move time by hand.
final clockProvider = Provider<DateTime Function()>((_) => DateTime.now);

/// How far the phone's clock is from the server's: `serverNow - phone now`,
/// worked out on each board (`serverNow` in `GET /api/rider/board`) at the
/// moment it arrives. Zero until a board has said. A phone whose clock is three
/// minutes fast has an offset of minus three minutes.
class ServerOffset extends Notifier<Duration> {
  /// A gap beyond this is not a clock that is a little off, it is a bad
  /// answer (or a phone set to the wrong year), and counting every offer
  /// window against it would be worse than trusting the phone.
  static const maxOffset = Duration(hours: 24);

  @override
  Duration build() => Duration.zero;

  /// Keeps [offset] unless it is beyond +-[maxOffset]; then the previous
  /// offset stays (and a debug build says so).
  void set(Duration offset) {
    if (offset.abs() > maxOffset) {
      if (kDebugMode) debugPrint('server clock offset of $offset ignored (more than $maxOffset)');
      return;
    }
    state = offset;
  }
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
