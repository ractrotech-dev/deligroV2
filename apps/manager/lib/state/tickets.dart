import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/outcome.dart';
import '../models/tickets.dart';
import 'providers.dart';

/// How often an open ticket re-asks (same cadence as an open order).
const ticketRefresh = Duration(seconds: 10);

/// One ticket and its messages. Writes re-read the thread afterwards so the
/// screen shows what the server holds, not a guess.
class TicketThreadNotifier extends AsyncNotifier<TicketThread> {
  TicketThreadNotifier(this.ticketId);
  final String ticketId;

  @override
  Future<TicketThread> build() async {
    ref.watch(signedInProvider);
    return ref.read(ticketsRepoProvider).thread(ticketId);
  }

  Future<void> refresh() async {
    if (!state.hasValue) {
      ref.invalidateSelf();
      return;
    }
    final next = await AsyncValue.guard(() => ref.read(ticketsRepoProvider).thread(ticketId));
    if (next.hasValue) state = next;
  }

  /// Throws on a network or server fault (retry with the same [r]).
  Future<Outcome<void>> reply(TicketReply r) async {
    final out = await ref.read(ticketsRepoProvider).reply(ticketId, r);
    await refresh();
    return out;
  }

  /// Throws on a network or server fault (retry with the same [s]).
  Future<Outcome<void>> setStatus(TicketStatusChange s) async {
    final out = await ref.read(ticketsRepoProvider).setStatus(ticketId, s);
    await refresh();
    return out;
  }
}

final ticketThreadProvider = AsyncNotifierProvider.autoDispose.family<TicketThreadNotifier, TicketThread, String>(
  TicketThreadNotifier.new,
  retry: (_, _) => null,
);
