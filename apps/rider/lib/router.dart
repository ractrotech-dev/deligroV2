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
import 'models/rider_me.dart';
import 'state/providers.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

/// The screens that only exist to say where the gate stands. Once the rider is
/// through, they are never shown.
const _gatePaths = {'/login', '/gate', '/not-rider', '/needs-update'};

/// Where a signed-in user [uid] belongs while `/api/rider/me` has not said
/// yes for them:
///
///   403            -> /not-rider    (a customer, vendor or admin account)
///   404, 503       -> /needs-update (a server without the rider routes)
///   anything else  -> /gate         (loading, or a network failure with Retry)
///
/// Riverpod keeps the previous value on an AsyncLoading or AsyncError that
/// follows data, so `hasValue` alone would let the last rider's answer open the
/// gate for whoever signs in next, and for any later 403 or outage. The user is
/// through only when the data is *this* user's and the latest answer was not an
/// error. A refresh of the same rider's data (loading, same id) stays through.
///
/// A 401 signs the app out inside [meProvider]; the redirect then sees no
/// session and sends the user to /login.
String _gateFor(AsyncValue<RiderMe> me, String? uid) {
  if (me.hasError && !me.isLoading) {
    final error = me.error;
    if (error is ApiException) {
      if (error.status == 403) return '/not-rider';
      if (error.status == 404 || error.status == 503) return '/needs-update';
    }
    return '/gate';
  }
  if (!me.hasError && me.hasValue && uid != null && me.value!.id == uid) return '/home';
  return '/gate';
}

/// Re-runs the redirect on sign-in/out and whenever `me` changes.
class _RouterRefresh extends ChangeNotifier {
  _RouterRefresh(Ref ref) {
    final auth = ref.read(supabaseProvider).auth;
    _uid = auth.currentUser?.id;
    _auth = auth.onAuthStateChange.listen((_) {
      // A different user: drop the last user's answer now, so the redirect that
      // follows reads "loading", not their value or their error.
      final uid = auth.currentUser?.id;
      if (uid != _uid) {
        _uid = uid;
        ref.invalidate(meProvider);
      }
      notifyListeners();
    });
    ref.listen(meProvider, (_, _) => notifyListeners());
  }

  String? _uid;
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
      final auth = ref.read(supabaseProvider).auth;
      if (auth.currentSession == null) return path == '/login' ? null : '/login';

      final gate = _gateFor(ref.read(meProvider), auth.currentUser?.id);
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
