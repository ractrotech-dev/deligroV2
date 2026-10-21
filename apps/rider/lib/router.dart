import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/api.dart';
import 'features/auth/login_screen.dart';
import 'features/gate/gate_screen.dart';
import 'features/gate/needs_update_screen.dart';
import 'features/gate/not_rider_screen.dart';
import 'features/home/home_screen.dart';
import 'state/providers.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

/// The screens that only exist to say where the gate stands. Once the rider is
/// through, they are never shown.
const _gatePaths = {'/login', '/gate', '/not-rider', '/needs-update'};

/// Where a signed-in user belongs while `/api/rider/me` has not said yes:
///
///   403            → /not-rider    (a customer, vendor or admin account)
///   404, 503       → /needs-update (a server without the rider routes)
///   anything else  → /gate         (loading, or a network failure with Retry)
///
/// A 401 signs the app out inside [meProvider]; the redirect then sees no
/// session and sends the user to /login.
String _gateFor(AsyncValue<Object?> me) {
  if (me.hasValue) return '/home';
  final error = me.error;
  if (error is ApiException) {
    if (error.status == 403) return '/not-rider';
    if (error.status == 404 || error.status == 503) return '/needs-update';
  }
  return '/gate';
}

/// Re-runs the redirect on sign-in/out and whenever `me` changes.
class _RouterRefresh extends ChangeNotifier {
  _RouterRefresh(Ref ref) {
    _auth = ref.read(supabaseProvider).auth.onAuthStateChange.listen((_) => notifyListeners());
    ref.listen(meProvider, (_, _) => notifyListeners());
  }

  late final StreamSubscription<dynamic> _auth;

  @override
  void dispose() {
    _auth.cancel();
    super.dispose();
  }
}

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefresh(ref);
  ref.onDispose(refresh.dispose);

  return GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: '/home',
    refreshListenable: refresh,
    redirect: (context, state) {
      final path = state.matchedLocation;
      final signedIn = ref.read(supabaseProvider).auth.currentSession != null;
      if (!signedIn) return path == '/login' ? null : '/login';

      final gate = _gateFor(ref.read(meProvider));
      if (gate == '/home') {
        // Through the gate: its own screens have nothing left to say.
        return _gatePaths.contains(path) ? '/home' : null;
      }
      return path == gate ? null : gate;
    },
    routes: [
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/gate', builder: (_, _) => const GateScreen()),
      GoRoute(path: '/not-rider', builder: (_, _) => const NotRiderScreen()),
      GoRoute(path: '/needs-update', builder: (_, _) => const NeedsUpdateScreen()),
      GoRoute(path: '/home', builder: (_, _) => const HomeScreen()),
    ],
  );
});
