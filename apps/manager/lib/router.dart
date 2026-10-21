import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'features/auth/gate_screens.dart';
import 'features/auth/login_screen.dart';
import 'models/manager_me.dart';
import 'state/providers.dart';
import 'state/session.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

const _gatePaths = {'/login', '/boot', '/not-manager'};

/// Where the gate sends someone, or null to let them through.
///
/// Signed out → /login. Signed in → /boot while `/api/manager/me` loads (and
/// for a fault, with Retry), /not-manager when the account is not a manager
/// or admin, and on into the app once it answers.
String? gateRedirect({
  required bool signedIn,
  required AsyncValue<ManagerMe?> me,
  required String path,
}) {
  if (!signedIn) return path == '/login' ? null : '/login';
  if (me.hasError && !me.isLoading) {
    final target = isNotManagerError(me.error) ? '/not-manager' : '/boot';
    return path == target ? null : target;
  }
  if (me.value == null) return path == '/boot' ? null : '/boot';
  return _gatePaths.contains(path) ? '/' : null;
}

/// Re-runs the redirect when the session or the manager record changes.
class _RouterRefresh extends ChangeNotifier {
  _RouterRefresh(Ref ref) {
    ref.listen(signedInProvider, (_, _) => notifyListeners());
    ref.listen(managerMeProvider, (_, _) => notifyListeners());
  }
}

/// The signed-in routes. Replaced by the shell in [appRoutes].
List<RouteBase> appRoutes() => [
      GoRoute(path: '/', builder: (_, _) => const Scaffold(body: Center(child: Text('Deligro Manager')))),
    ];

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefresh(ref);
  ref.onDispose(refresh.dispose);

  return GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: '/boot',
    refreshListenable: refresh,
    redirect: (context, state) => gateRedirect(
      signedIn: ref.read(signedInProvider),
      me: ref.read(managerMeProvider),
      path: state.matchedLocation,
    ),
    routes: [
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/boot', builder: (_, _) => const BootScreen()),
      GoRoute(path: '/not-manager', builder: (_, _) => const NotManagerScreen()),
      ...appRoutes(),
    ],
  );
});
