import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/order.dart';

/// What stands between this phone and a ring that actually wakes it.
class RingSetup {
  const RingSetup({
    required this.notifications,
    required this.fullScreen,
    required this.batteryUnrestricted,
    required this.manufacturer,
  });

  factory RingSetup.fromMap(Map<Object?, Object?> m) => RingSetup(
        notifications: m['notifications'] == true,
        fullScreen: m['fullScreen'] != false,
        batteryUnrestricted: m['batteryUnrestricted'] == true,
        manufacturer: '${m['manufacturer'] ?? ''}',
      );

  final bool notifications;
  final bool fullScreen;
  final bool batteryUnrestricted;
  final String manufacturer;

  /// Makers whose own "autostart" switch can stop a ring from waking the app.
  bool get hasAutostart => const {'xiaomi', 'redmi', 'poco', 'vivo', 'iqoo', 'oppo', 'realme', 'oneplus'}
      .contains(manufacturer.toLowerCase());

  bool get ready => notifications && fullScreen && batteryUnrestricted;
}

/// The native ring (RingService.kt) through MainActivity's "deligro/ring"
/// channel. Every call is best-effort: a phone that can't ring still works.
class RingChannel {
  static const _ch = MethodChannel('deligro/ring');

  Future<bool> start(String ringId, {required String title, required String body, int timeoutSec = 300}) async {
    try {
      return await _ch.invokeMethod<bool>('start', {
            'ringId': ringId,
            'title': title,
            'body': body,
            'timeoutSec': timeoutSec,
          }) ??
          false;
    } catch (_) {
      return false;
    }
  }

  /// `*` stops every ring.
  Future<void> stop(String ringId) async {
    try {
      await _ch.invokeMethod<bool>('stop', {'ringId': ringId});
    } catch (_) {}
  }

  Future<RingSetup?> setup() async {
    try {
      final m = await _ch.invokeMethod<Map<Object?, Object?>>('setup');
      return m == null ? null : RingSetup.fromMap(m);
    } catch (_) {
      return null;
    }
  }

  /// [which]: `notifications`, `fullScreen`, `battery` or `autostart`.
  Future<void> openSettings(String which) async {
    try {
      await _ch.invokeMethod<bool>('openSettings', {'which': which});
    } catch (_) {}
  }
}

final ringChannelProvider = Provider((_) => RingChannel());

/// The same ring id the server's pushes use (src/lib/alerts/ring.ts), so a
/// ring the board started stops when the server's stop arrives, and vice versa.
String vendorRingId(String orderId) => 'vendor:$orderId';

/// Which rings to start and stop, given what is ringing and the board now.
({Set<String> start, Set<String> stop}) ringDiff(Set<String> ringing, Iterable<VendorOrder> orders) {
  final waiting = {for (final o in orders.where((o) => o.stage == OrderStage.newOrder)) vendorRingId(o.id)};
  return (start: waiting.difference(ringing), stop: ringing.difference(waiting));
}

/// Rings for every new order on the open board until it moves on. The push
/// extension covers the app being closed; this covers it being open (and an
/// order whose push never arrived).
class BoardRinger extends Notifier<Set<String>> {
  @override
  Set<String> build() => const {};

  Future<void> sync(Iterable<VendorOrder> orders, {required String Function(VendorOrder) title, required String Function(VendorOrder) body}) async {
    final diff = ringDiff(state, orders);
    if (diff.start.isEmpty && diff.stop.isEmpty) return;
    final ch = ref.read(ringChannelProvider);
    final byRing = {for (final o in orders) vendorRingId(o.id): o};
    for (final id in diff.stop) {
      await ch.stop(id);
    }
    for (final id in diff.start) {
      final o = byRing[id]!;
      await ch.start(id, title: title(o), body: body(o));
    }
    state = {...state.difference(diff.stop), ...diff.start};
  }

  Future<void> stopAll() async {
    await ref.read(ringChannelProvider).stop('*');
    state = const {};
  }
}

final boardRingerProvider = NotifierProvider<BoardRinger, Set<String>>(BoardRinger.new);
