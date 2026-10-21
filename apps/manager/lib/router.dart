import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'features/auth/gate_screens.dart';
import 'features/auth/login_screen.dart';
import 'features/home/home_screen.dart';
import 'features/live/live_screen.dart';
import 'features/more/more_screen.dart';
import 'features/orders/order_detail_screen.dart';
import 'features/orders/orders_screen.dart';
import 'features/products/product_categories_screen.dart';
import 'features/products/product_detail_screen.dart';
import 'features/products/product_insights_screen.dart';
import 'features/products/products_screen.dart';
import 'features/products/restricted_categories_screen.dart';
import 'features/riders/rider_detail_screen.dart';
import 'features/riders/rider_onboard_screen.dart';
import 'features/riders/riders_screen.dart';
import 'features/profile/account_screens.dart';
import 'features/profile/profile_screen.dart';
import 'features/settings/settings_screen.dart';
import 'features/shell/manager_shell.dart';
import 'features/shell/nav.dart';
import 'features/stats/stats_screen.dart';
import 'features/support/ticket_thread_screen.dart';
import 'features/vendors/onboard/onboard_flow.dart';
import 'features/vendors/vendor_detail_screen.dart';
import 'features/vendors/vendors_screen.dart';
import 'widgets/phase_placeholder.dart';
import 'models/manager_me.dart';
import 'state/providers.dart';
import 'state/session.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

const _gatePaths = {'/login', '/boot', '/not-manager'};

/// Where the gate sends someone, or null to let them through.
///
/// Signed out → /login. Signed in → /boot while `/api/manager/me` loads (and
/// for a fault, with Retry), /not-manager when the account is not a manager
/// or admin, and on into the app once it answers. A screen whose permission
/// is off sends them home — the server refuses its data either way.
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
  final m = me.value;
  if (m == null) return path == '/boot' ? null : '/boot';
  if (_gatePaths.contains(path)) return '/';
  final needed = permissionFor(path);
  if (needed != null && !m.can(needed)) return '/';
  return null;
}

/// Re-runs the redirect when the session or the manager record changes.
class _RouterRefresh extends ChangeNotifier {
  _RouterRefresh(Ref ref) {
    ref.listen(signedInProvider, (_, _) => notifyListeners());
    ref.listen(managerMeProvider, (_, _) => notifyListeners());
  }
}

/// A screen a later build phase delivers, labelled as such.
Widget _pending({required String title, required IconData icon, required int phase}) =>
    PhasePlaceholder(title: title, icon: icon, phase: phase);

/// A main tab a later phase delivers (no back button: it is a tab).
Widget _pendingTab(TabDef t, int phase, String what) => Scaffold(
      appBar: AppBar(title: Text(t.en)),
      body: PhasePlaceholder(showAppBar: false, title: t.en, icon: t.icon, phase: phase, what: what),
    );

/// The signed-in app: the five tabs, with More's screens pushed over them.
List<RouteBase> appRoutes() => [
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => ManagerShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [
            GoRoute(path: '/', builder: (_, _) => const HomeScreen()),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/orders',
              builder: (_, state) => OrdersScreen(query: state.uri),
              routes: [
                GoRoute(
                  path: ':id',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, state) => OrderDetailScreen(orderId: state.pathParameters['id']!),
                ),
              ],
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/live',
              builder: (_, state) => LiveScreen(query: state.uri),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/finance',
              builder: (_, _) => _pendingTab(tabs[3], 6, 'Sales, commission, settlements, payouts and reconciliation.'),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/more',
              builder: (_, _) => const MoreScreen(),
              routes: [
                GoRoute(
                  path: 'profile',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, _) => const ProfileScreen(),
                  routes: [
                    GoRoute(path: 'permissions', parentNavigatorKey: rootNavigatorKey, builder: (_, _) => const PermissionsScreen()),
                    GoRoute(path: 'activity', parentNavigatorKey: rootNavigatorKey, builder: (_, _) => const ActivityScreen()),
                    GoRoute(path: 'sessions', parentNavigatorKey: rootNavigatorKey, builder: (_, _) => const SessionsScreen()),
                    GoRoute(path: 'password', parentNavigatorKey: rootNavigatorKey, builder: (_, _) => const PasswordScreen()),
                    GoRoute(
                      path: 'notifications',
                      parentNavigatorKey: rootNavigatorKey,
                      builder: (_, _) => const NotificationPrefsScreen(),
                    ),
                  ],
                ),
                GoRoute(path: 'settings', parentNavigatorKey: rootNavigatorKey, builder: (_, _) => const SettingsScreen()),
                GoRoute(
                  path: 'products',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, state) => ProductsScreen(query: state.uri),
                  routes: [
                    // Fixed paths before ':id'.
                    GoRoute(
                      path: 'categories',
                      parentNavigatorKey: rootNavigatorKey,
                      builder: (_, _) => const ProductCategoriesScreen(),
                    ),
                    GoRoute(
                      path: 'insights',
                      parentNavigatorKey: rootNavigatorKey,
                      builder: (_, _) => const ProductInsightsScreen(),
                    ),
                    GoRoute(
                      path: 'restricted',
                      parentNavigatorKey: rootNavigatorKey,
                      builder: (_, _) => const RestrictedCategoriesScreen(),
                    ),
                    GoRoute(
                      path: ':id',
                      parentNavigatorKey: rootNavigatorKey,
                      builder: (_, state) => ProductDetailScreen(productId: state.pathParameters['id']!),
                    ),
                  ],
                ),
                GoRoute(
                  path: 'tickets/:id',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, state) => TicketThreadScreen(ticketId: state.pathParameters['id']!),
                ),
                GoRoute(
                  path: 'riders',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, state) => RidersScreen(
                    query: state.uri,
                    detailPane: (id) => RiderDetailBody(riderId: id),
                  ),
                  routes: [
                    // Before ':id', or "new" would be read as a rider id.
                    GoRoute(
                      path: 'new',
                      parentNavigatorKey: rootNavigatorKey,
                      builder: (_, _) => const RiderOnboardScreen(),
                    ),
                    GoRoute(
                      path: ':id',
                      parentNavigatorKey: rootNavigatorKey,
                      builder: (_, state) => RiderDetailScreen(riderId: state.pathParameters['id']!),
                    ),
                  ],
                ),
                GoRoute(
                  path: 'vendors',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, state) => VendorsScreen(query: state.uri),
                  routes: [
                    // Before ':id', or "new" would be read as a vendor id.
                    GoRoute(
                      path: 'new',
                      parentNavigatorKey: rootNavigatorKey,
                      builder: (_, _) => const OnboardFlow(),
                    ),
                    GoRoute(
                      path: ':id',
                      parentNavigatorKey: rootNavigatorKey,
                      builder: (_, state) => VendorDetailScreen(vendorId: state.pathParameters['id']!),
                    ),
                  ],
                ),
                for (final m in moreItems.where((m) => m.phase != null))
                  GoRoute(
                    path: m.path.substring('/more/'.length),
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, _) => _pending(title: m.en, icon: m.icon, phase: m.phase!),
                  ),
              ],
            ),
          ]),
        ],
      ),
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
      GoRoute(
        path: '/stats',
        builder: (_, state) => StatsScreen(
          vendorId: state.uri.queryParameters['vendor'],
          vendorName: state.uri.queryParameters['name'],
        ),
      ),
      GoRoute(path: '/boot', builder: (_, _) => const BootScreen()),
      GoRoute(path: '/not-manager', builder: (_, _) => const NotManagerScreen()),
      ...appRoutes(),
    ],
  );
});
