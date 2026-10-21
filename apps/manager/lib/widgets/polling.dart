import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

/// Calls [onTick] every [interval] while this widget is actually on screen
/// and the app is in front — and at no other time.
///
/// "On screen" is read from [TickerMode]: a tab the bottom bar has switched
/// away from, and a screen covered by one pushed over it, both have tickers
/// disabled, so neither keeps asking the server. Backgrounding the app stops
/// the timer; coming back fires one tick at once and restarts it. (Design:
/// Live and Orders poll every 10 s while foregrounded.)
class Polling extends StatefulWidget {
  const Polling({super.key, required this.interval, required this.onTick, required this.child});

  final Duration interval;
  final VoidCallback onTick;
  final Widget child;

  @override
  State<Polling> createState() => _PollingState();
}

class _PollingState extends State<Polling> {
  Timer? _timer;
  AppLifecycleListener? _lifecycle;
  ValueListenable<TickerModeData>? _ticker;
  bool _resumed = true;

  @override
  void initState() {
    super.initState();
    final state = WidgetsBinding.instance.lifecycleState;
    _resumed = state == null || state == AppLifecycleState.resumed;
    _lifecycle = AppLifecycleListener(
      onResume: () {
        _resumed = true;
        if (_visible) widget.onTick();
        _sync();
      },
      onPause: () {
        _resumed = false;
        _sync();
      },
      onHide: () {
        _resumed = false;
        _sync();
      },
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final next = TickerMode.getValuesNotifier(context);
    if (!identical(next, _ticker)) {
      _ticker?.removeListener(_onTickerMode);
      _ticker = next..addListener(_onTickerMode);
    }
    _sync();
  }

  @override
  void didUpdateWidget(Polling old) {
    super.didUpdateWidget(old);
    if (old.interval != widget.interval) {
      _timer?.cancel();
      _timer = null;
      _sync();
    }
  }

  bool get _visible => _ticker?.value.enabled ?? true;

  void _onTickerMode() {
    // Coming back into view: catch up at once rather than waiting a period.
    if (_visible && _resumed && _timer == null) widget.onTick();
    _sync();
  }

  void _sync() {
    final run = _visible && _resumed;
    if (run && _timer == null) {
      _timer = Timer.periodic(widget.interval, (_) => widget.onTick());
    } else if (!run && _timer != null) {
      _timer!.cancel();
      _timer = null;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    _ticker?.removeListener(_onTickerMode);
    _lifecycle?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
