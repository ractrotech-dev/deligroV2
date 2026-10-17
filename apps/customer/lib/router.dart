import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'features/auth/login_screen.dart';
import 'features/checkout/checkout_screen.dart';
import 'features/home/home_screen.dart';
import 'features/location/location_screen.dart';
import 'features/orders/orders_screen.dart';
import 'features/orders/receipt_screen.dart';
import 'features/orders/tracking_screen.dart';
import 'features/profile/about_screen.dart';
import 'features/profile/addresses_screen.dart';
import 'features/profile/favorites_screen.dart';
import 'features/profile/help_screen.dart';
import 'features/profile/profile_screen.dart';
import 'features/restaurant/restaurant_screen.dart';
import 'features/search/search_screen.dart';
import 'features/shell/home_shell.dart';
import 'features/stores/stores_screen.dart';
import 'state/prefs.dart';
import 'state/providers.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

/// Pages that need a real sign-in (proxy.ts on the web): checkout, orders and
/// profile. Everything else is open to a signed-in customer or a guest.
bool _needsSession(String path) =>
    path.startsWith('/checkout') || path.startsWith('/orders') || path.startsWith('/profile');

/// Re-runs the redirect on sign-in/out and when "browse as guest" flips.
class _RouterRefresh extends ChangeNotifier {
  _RouterRefresh(Ref ref) {
    _auth = ref.read(supabaseProvider).auth.onAuthStateChange.listen((_) => notifyListeners());
    ref.listen(guestProvider, (_, _) => notifyListeners());
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
    initialLocation: '/',
    refreshListenable: refresh,
    redirect: (context, state) {
      final signedIn = ref.read(supabaseProvider).auth.currentSession != null;
      final guest = ref.read(guestProvider);
      final path = state.matchedLocation;

      if (path == '/login') {
        if (!signedIn) return null;
        final next = state.uri.queryParameters['next'];
        return next != null && next.startsWith('/') && !next.startsWith('/login') ? next : '/';
      }
      if (signedIn) return null;
      if (_needsSession(path)) {
        return '/login?next=${Uri.encodeComponent(state.uri.toString())}';
      }
      return guest ? null : '/login';
    },
    routes: [
      GoRoute(
        path: '/login',
        builder: (_, s) => LoginScreen(next: s.uri.queryParameters['next']),
      ),
      GoRoute(
        path: '/restaurant/:slug',
        builder: (_, s) => RestaurantScreen(slug: s.pathParameters['slug']!),
      ),
      GoRoute(path: '/checkout', builder: (_, _) => const CheckoutScreen()),
      GoRoute(path: '/location', builder: (_, _) => const LocationScreen()),
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => HomeShell(shell: shell),
        branches: [
          StatefulShellBranch(routes: [
            GoRoute(path: '/', builder: (_, _) => const HomeScreen()),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/stores',
              builder: (_, s) => StoresScreen(category: s.uri.queryParameters['category']),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/search',
              builder: (_, s) => SearchScreen(
                key: ValueKey(s.uri.toString()),
                query: s.uri.queryParameters['q'],
                category: s.uri.queryParameters['category'],
              ),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/orders',
              builder: (_, _) => const OrdersScreen(),
              routes: [
                GoRoute(
                  path: ':id',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, s) => TrackingScreen(
                    orderId: s.pathParameters['id']!,
                    justPlaced: s.uri.queryParameters['placed'] == '1',
                  ),
                  routes: [
                    GoRoute(
                      path: 'receipt',
                      parentNavigatorKey: rootNavigatorKey,
                      builder: (_, s) => ReceiptScreen(orderId: s.pathParameters['id']!),
                    ),
                  ],
                ),
              ],
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/profile',
              builder: (_, _) => const ProfileScreen(),
              routes: [
                GoRoute(
                  path: 'addresses',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, _) => const AddressesScreen(),
                ),
                GoRoute(
                  path: 'favorites',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, _) => const FavoritesScreen(),
                ),
                GoRoute(
                  path: 'help',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, s) => HelpScreen(orderId: s.uri.queryParameters['order']),
                ),
                GoRoute(
                  path: 'about',
                  parentNavigatorKey: rootNavigatorKey,
                  builder: (_, _) => const AboutScreen(),
                ),
              ],
            ),
          ]),
        ],
      ),
    ],
  );
});
