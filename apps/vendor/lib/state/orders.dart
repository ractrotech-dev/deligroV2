import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/orders_repository.dart';
import '../models/order.dart';
import 'providers.dart';

final ordersRepoProvider = Provider((ref) => OrdersRepository(ref.watch(apiProvider)));

class BoardState {
  const BoardState({required this.orders, required this.updatedAt, this.stale = false});

  final List<VendorOrder> orders;
  final DateTime updatedAt;

  /// The last refresh failed; [orders] is the last good board.
  final bool stale;

  int count(OrderStage? stage) => stage == null ? orders.length : orders.where((o) => o.stage == stage).length;

  /// Ready orders and those out for delivery share the board's last column.
  int get outForDelivery => orders.where((o) => o.status == 'on_the_way').length;
}

/// The live board. Polls every [interval] while something listens and the
/// app is in front (the web board refreshes every 8 s too); a failed poll keeps
/// the last good board and marks it stale rather than blanking the screen.
class BoardNotifier extends AsyncNotifier<BoardState> {
  static const interval = Duration(seconds: 8);
  Timer? _timer;
  AppLifecycleListener? _lifecycle;

  @override
  Future<BoardState> build() async {
    ref.watch(activeShopSlugProvider);
    _timer?.cancel();
    _timer = Timer.periodic(interval, (_) {
      final life = WidgetsBinding.instance.lifecycleState;
      if (life == null || life == AppLifecycleState.resumed) refresh();
    });
    _lifecycle ??= AppLifecycleListener(onResume: refresh);
    ref.onDispose(() {
      _timer?.cancel();
      _lifecycle?.dispose();
      _lifecycle = null;
    });
    return _load();
  }

  Future<BoardState> _load() async =>
      BoardState(orders: await ref.read(ordersRepoProvider).board(), updatedAt: DateTime.now());

  Future<void> refresh() async {
    try {
      final next = await _load();
      state = AsyncData(next);
    } catch (e, st) {
      final prev = state.value;
      state = prev != null
          ? AsyncData(BoardState(orders: prev.orders, updatedAt: prev.updatedAt, stale: true))
          : AsyncError(e, st);
    }
  }
}

final boardProvider = AsyncNotifierProvider.autoDispose<BoardNotifier, BoardState>(BoardNotifier.new);

/// One order with its history, for the detail screen.
final orderDetailProvider = FutureProvider.autoDispose.family<VendorOrder, String>(
  (ref, id) => ref.watch(ordersRepoProvider).detail(id),
);
