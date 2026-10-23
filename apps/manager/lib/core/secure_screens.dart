import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

/// Finance and customer screens are kept out of screenshots, screen recordings
/// and the recent-apps thumbnail (Android `FLAG_SECURE`).
///
/// The flag follows the screen that is on top, however it was reached — a tap,
/// a push, a deep link from a cold start, back navigation — because it is
/// derived from the router's current location, not from the tap that led there.
/// `*` matches exactly one path segment.
const securePatterns = <String>[
  '/finance', // overview, dues, issues, reconciliation, refunds, payouts, settlements
  '/more/customers', // list, detail, retention
  '/more/approvals', // payment requests
  '/more/reports', // report previews show money and customers
  '/more/cash', // handovers and deposits
  '/more/riders/*/ledger', // a rider's pay records
];

List<String> _segments(String path) => path.split('?').first.split('/').where((s) => s.isNotEmpty).toList();

/// Whether [pattern] covers [segments] — the pattern is a prefix of the path.
bool _covers(List<String> pattern, List<String> segments) {
  if (segments.length < pattern.length) return false;
  for (var i = 0; i < pattern.length; i++) {
    if (pattern[i] != '*' && pattern[i] != segments[i]) return false;
  }
  return true;
}

/// Whether a location (`/more/customers/abc`, with or without a query) is a secure screen.
bool isSecureLocation(String location) {
  final segments = _segments(location);
  return securePatterns.any((p) => _covers(_segments(p), segments));
}

/// Whether the route [path] declared in the router (`/more/riders/:id/ledger`) is covered
/// by [pattern]. Used by the tests to prove every listed pattern points at a real screen.
bool patternMatchesRoute(String pattern, String routePath) {
  final route = _segments(routePath).map((s) => s.startsWith(':') ? '*' : s).toList();
  final pat = _segments(pattern);
  if (route.length < pat.length) return false;
  for (var i = 0; i < pat.length; i++) {
    if (pat[i] != route[i] && pat[i] != '*' && route[i] != '*') return false;
  }
  return true;
}

/// How the flag reaches the window. A seam so tests don't need a device.
abstract class SecureChannel {
  Future<void> setSecure(bool secure);
}

class MethodSecureChannel implements SecureChannel {
  const MethodSecureChannel();
  static const _channel = MethodChannel('deligro/secure');

  @override
  Future<void> setSecure(bool secure) async {
    try {
      await _channel.invokeMethod<void>('setSecure', {'secure': secure});
    } on MissingPluginException {
      // Not Android (tests, desktop): there is nothing to protect.
    } on PlatformException {
      // A refused flag must not break navigation.
    }
  }
}

/// How many [SecureScope]s are on screen. Part of what decides the flag.
final ValueNotifier<int> secureScopeCount = ValueNotifier<int>(0);

/// Keeps its child out of screenshots while it is on screen — for sensitive
/// content that is not a route of its own (a tab, a side-by-side detail pane).
class SecureScope extends StatefulWidget {
  const SecureScope({super.key, required this.child});
  final Widget child;

  @override
  State<SecureScope> createState() => _SecureScopeState();
}

class _SecureScopeState extends State<SecureScope> {
  bool _counted = false;

  @override
  void initState() {
    super.initState();
    // After the frame: the controller listens to this count, and a notifier must not
    // change in the middle of a build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _counted = true;
      secureScopeCount.value++;
    });
  }

  @override
  void dispose() {
    // Only undo what this scope actually added.
    if (_counted) secureScopeCount.value--;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// Sets and clears the flag as the top location changes. Calls the channel only
/// when the answer changes.
class SecureScreenController {
  SecureScreenController({required this.router, this.channel = const MethodSecureChannel()});

  final GoRouter router;
  final SecureChannel channel;
  bool _applied = false;
  bool _started = false;

  /// What the window flag currently is, as far as this controller knows.
  bool get secure => _applied;

  void start() {
    if (_started) return;
    _started = true;
    router.routerDelegate.addListener(_evaluate);
    secureScopeCount.addListener(_evaluate);
    _evaluate();
  }

  void dispose() {
    if (!_started) return;
    _started = false;
    router.routerDelegate.removeListener(_evaluate);
    secureScopeCount.removeListener(_evaluate);
  }

  void _evaluate() {
    final location = router.routerDelegate.currentConfiguration.uri.toString();
    final want = isSecureLocation(location) || secureScopeCount.value > 0;
    if (want == _applied) return;
    _applied = want;
    channel.setSecure(want);
  }
}
