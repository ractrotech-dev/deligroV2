import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/i18n.dart';
import 'features/auth/boot_screen.dart';
import 'features/auth/login_screen.dart';
import 'features/auth/no_shop_screen.dart';
import 'features/home/home_screen.dart';
import 'features/more/more_screen.dart';
import 'features/more/settings_screen.dart';
import 'features/orders/order_detail_screen.dart';
import 'features/orders/orders_screen.dart';
import 'features/shell/shell.dart';
import 'state/providers.dart';
import 'state/session.dart';
import 'widgets/section_placeholder.dart';

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

/// A More entry whose phase hasn't landed yet.
Widget _pending(String path) => Consumer(builder: (_, ref, _) {
      final e = moreEntries.firstWhere((m) => m.path == path);
      return SectionPlaceholder(title: tr(ref, e.en, e.hi), icon: e.icon);
    });

/// A main tab whose phase hasn't landed yet.
Widget _pendingTab(String en, String hi, IconData icon) => Consumer(
      builder: (_, ref, _) => SectionPlaceholder(title: tr(ref, en, hi), icon: icon),
    );

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
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => PartnerShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [
            GoRoute(path: '/', builder: (_, _) => const HomeScreen()),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/orders',
              builder: (_, s) => OrdersScreen(
                filter: s.uri.queryParameters['filter'],
                tab: s.uri.queryParameters['tab'],
                kind: s.uri.queryParameters['kind'],
              ),
              routes: [
                GoRoute(
                  path: ':id',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, s) => OrderDetailScreen(orderId: s.pathParameters['id']!),
                ),
              ],
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(path: '/reports', builder: (_, _) => _pendingTab('Reports', 'रिपोर्ट', Icons.bar_chart_outlined)),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/payments',
              builder: (_, _) => _pendingTab('Payments', 'भुगतान', Icons.account_balance_wallet_outlined),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/more',
              builder: (_, _) => const MoreScreen(),
              routes: [
                GoRoute(
                  path: 'settings',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, _) => const SettingsScreen(),
                ),
                for (final e in moreEntries.where((e) => e.path != '/more/settings'))
                  GoRoute(
                    path: e.path.substring('/more/'.length),
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, _) => _pending(e.path),
                  ),
              ],
            ),
          ]),
        ],
      ),
    ],
  );
});
