import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/dashboard.dart';
import '../widgets/zone_picker.dart';
import 'providers.dart';

/// How often Home re-asks while it is on screen (design: Home every 30 s).
const dashboardRefresh = Duration(seconds: 30);

/// The dashboard for the zone on the picker (or all of this person's zones).
///
/// Re-fetches every [dashboardRefresh] only while Home is actually on screen —
/// the app in front *and* Home the visible tab with nothing pushed over it
/// ([setVisible], driven by [DashboardVisibility]). Coming back refreshes at
/// once. A refresh keeps the last figures on screen; a first load that fails
/// is an error with Retry, never a grid of zeros.
///
/// A refresh answers for the zone it asked about: if the picker moved on (or
/// the provider rebuilt) while it was in flight, the answer is dropped, so a
/// slow reply for zone A can never paint over zone B's figures.
class DashboardNotifier extends AsyncNotifier<DashboardData> {
  Timer? _timer;
  AppLifecycleListener? _lifecycle;
  bool _visible = true;
  bool _resumed = true;
  int _generation = 0;

  @override
  Future<DashboardData> build() async {
    ref.watch(signedInProvider);
    final zone = ref.watch(activeZoneProvider);
    _generation++;
    _listenToLifecycle();
    ref.onDispose(_stop);
    final data = await ref
        .read(managerRepoProvider)
        .dashboard(zoneId: zone?.id);
    _schedule();
    return data;
  }

  /// Home came on screen (true) or went behind another tab or screen (false).
  void setVisible(bool visible) {
    if (visible == _visible) return;
    _visible = visible;
    if (visible && _resumed) unawaited(refresh());
    _schedule();
  }

  void _listenToLifecycle() {
    _lifecycle?.dispose();
    _lifecycle = AppLifecycleListener(
      onResume: () {
        _resumed = true;
        if (_visible) unawaited(refresh());
        _schedule();
      },
      onPause: () {
        _resumed = false;
        _schedule();
      },
    );
  }

  void _schedule() {
    _timer?.cancel();
    _timer = _visible && _resumed
        ? Timer.periodic(dashboardRefresh, (_) => refresh())
        : null;
  }

  void _stop() {
    _timer?.cancel();
    _timer = null;
    _lifecycle?.dispose();
    _lifecycle = null;
  }

  /// Re-fetch in place: the figures stay visible while it runs.
  Future<void> refresh() async {
    final zoneId = ref.read(activeZoneProvider)?.id;
    final generation = _generation;
    final next = await AsyncValue.guard(
      () => ref.read(managerRepoProvider).dashboard(zoneId: zoneId),
    );
    final stale = !ref.mounted || generation != _generation || ref.read(activeZoneProvider)?.id != zoneId;
    if (stale) return;
    // A failed background refresh keeps the last good figures.
    if (next.hasValue || !state.hasValue) state = next;
  }
}

/// No automatic retry: a failed load shows the error and a Retry button (and
/// the 30-second refresh tries again anyway), rather than spinning silently.
final dashboardProvider =
    AsyncNotifierProvider.autoDispose<DashboardNotifier, DashboardData>(
      DashboardNotifier.new,
      retry: (_, _) => null,
    );

/// Tells the dashboard whether Home is on screen. go_router's shell puts the
/// tabs that are not current under `TickerMode(enabled: false)`, and the
/// navigator does the same to a screen covered by another (Statistics pushed
/// over Home, a More screen), so `TickerMode` is exactly "Home is visible".
class DashboardVisibility extends ConsumerStatefulWidget {
  const DashboardVisibility({super.key, required this.child});
  final Widget child;

  @override
  ConsumerState<DashboardVisibility> createState() =>
      _DashboardVisibilityState();
}

class _DashboardVisibilityState extends ConsumerState<DashboardVisibility> {
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final visible = TickerMode.valuesOf(context).enabled;
    // After this frame: a provider may not be changed while widgets build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(dashboardProvider.notifier).setVisible(visible);
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
