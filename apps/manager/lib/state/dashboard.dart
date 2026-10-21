import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/dashboard.dart';
import '../widgets/zone_picker.dart';
import 'providers.dart';

/// How often Home re-asks while the app is in front (design: Home every 30 s).
const dashboardRefresh = Duration(seconds: 30);

/// The dashboard for the zone on the picker (or all of this person's zones).
///
/// Re-fetches every [dashboardRefresh] while the app is resumed and stops while
/// it is in the background. A refresh keeps the last figures on screen; a first
/// load that fails is an error with Retry, never a grid of zeros.
class DashboardNotifier extends AsyncNotifier<DashboardData> {
  Timer? _timer;
  AppLifecycleListener? _lifecycle;

  @override
  Future<DashboardData> build() async {
    ref.watch(signedInProvider);
    final zone = ref.watch(activeZoneProvider);
    _start();
    ref.onDispose(_stop);
    return ref.read(managerRepoProvider).dashboard(zoneId: zone?.id);
  }

  void _start() {
    _stop();
    _timer = Timer.periodic(dashboardRefresh, (_) => refresh());
    _lifecycle = AppLifecycleListener(
      onResume: () {
        refresh();
        _timer ??= Timer.periodic(dashboardRefresh, (_) => refresh());
      },
      onPause: () {
        _timer?.cancel();
        _timer = null;
      },
    );
  }

  void _stop() {
    _timer?.cancel();
    _timer = null;
    _lifecycle?.dispose();
    _lifecycle = null;
  }

  /// Re-fetch in place: the figures stay visible while it runs.
  Future<void> refresh() async {
    final zone = ref.read(activeZoneProvider);
    final next = await AsyncValue.guard(() => ref.read(managerRepoProvider).dashboard(zoneId: zone?.id));
    // A failed background refresh keeps the last good figures.
    if (next.hasValue || !state.hasValue) state = next;
  }
}

/// No automatic retry: a failed load shows the error and a Retry button (and
/// the 30-second refresh tries again anyway), rather than spinning silently.
final dashboardProvider = AsyncNotifierProvider.autoDispose<DashboardNotifier, DashboardData>(
  DashboardNotifier.new,
  retry: (_, _) => null,
);
