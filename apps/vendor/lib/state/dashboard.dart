import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/dashboard.dart';
import 'providers.dart';

/// The home figures. "All dashboard figures must update automatically"
/// (requirements §1): refreshed every 30 s while the screen is open and the
/// app is in front, on resume, and on pull.
class DashboardNotifier extends AsyncNotifier<Dashboard> {
  static const interval = Duration(seconds: 30);
  Timer? _timer;
  AppLifecycleListener? _life;

  @override
  Future<Dashboard> build() async {
    ref.watch(activeShopSlugProvider);
    _timer?.cancel();
    _timer = Timer.periodic(interval, (_) {
      final life = WidgetsBinding.instance.lifecycleState;
      if (life == null || life == AppLifecycleState.resumed) refresh();
    });
    _life ??= AppLifecycleListener(onResume: refresh);
    ref.onDispose(() {
      _timer?.cancel();
      _life?.dispose();
      _life = null;
    });
    return _load();
  }

  Future<Dashboard> _load() async => Dashboard.fromJson(await ref.read(apiProvider).get('/api/vendor/dashboard'));

  /// Keeps the last figures on a failed refresh.
  Future<void> refresh() async {
    try {
      state = AsyncData(await _load());
    } catch (e, st) {
      if (state.value == null) state = AsyncError(e, st);
    }
  }
}

final dashboardProvider = AsyncNotifierProvider.autoDispose<DashboardNotifier, Dashboard>(DashboardNotifier.new);
