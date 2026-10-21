import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'features/auth/boot_screen.dart';
import 'features/auth/login_screen.dart';
import 'features/auth/no_shop_screen.dart';
import 'features/shell/home_placeholder.dart';
import 'state/providers.dart';
import 'state/session.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

const _gatePaths = {'/login', '/boot', '/no-shop'};

/// Where the gate sends someone, or null to let them through.
///
/// Signed out → /login. Signed in → /boot while `/api/vendor/me` loads (and
/// for a fault, with Retry), /no-shop when the account runs no shop, and on
/// into the app once it answers.
String? gateRedirect({
  required bool signedIn,
  required AsyncValue<Object?> me,
  required String path,
}) {
  if (!signedIn) return path == '/login' ? null : '/login';
  if (me.hasError && !me.isLoading) {
    final target = isNoShopError(me.error) ? '/no-shop' : '/boot';
    return path == target ? null : target;
  }
  if (me.value == null) return path == '/boot' ? null : '/boot';
  return _gatePaths.contains(path) ? '/' : null;
}

/// Re-runs the redirect when the session or the vendor record changes.
class _RouterRefresh extends ChangeNotifier {
  _RouterRefresh(Ref ref) {
    ref.listen(signedInProvider, (_, _) => notifyListeners());
    ref.listen(vendorMeProvider, (_, _) => notifyListeners());
  }
}

final routerProvider = Provider<GoRouter>((ref) {
  final refresh = _RouterRefresh(ref);
  ref.onDispose(refresh.dispose);

  return GoRouter(
    navigatorKey: rootNavigatorKey,
    initialLocation: '/boot',
    refreshListenable: refresh,
    redirect: (context, state) => gateRedirect(
      signedIn: ref.read(signedInProvider),
      me: ref.read(vendorMeProvider),
      path: state.matchedLocation,
    ),
    routes: [
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/boot', builder: (_, _) => const BootScreen()),
      GoRoute(path: '/no-shop', builder: (_, _) => const NoShopScreen()),
      GoRoute(path: '/', builder: (_, _) => const HomePlaceholder()),
    ],
  );
});
