import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/feature_gates.dart';
import 'features/auth/boot_screen.dart';
import 'features/auth/login_screen.dart';
import 'features/auth/no_shop_screen.dart';
import 'features/documents/document_screen.dart';
import 'features/documents/invoices_screen.dart';
import 'features/home/home_screen.dart';
import 'features/marketing/marketing_screens.dart';
import 'features/notifications/notifications_screen.dart';
import 'features/offers/offer_editor_screen.dart';
import 'features/offers/offers_screen.dart';
import 'features/reviews/reviews_screen.dart';
import 'features/support/support_screens.dart';
import 'models/growth.dart';
import 'models/vendor_me.dart';
import 'features/more/more_screen.dart';
import 'features/more/settings_screen.dart';
import 'features/orders/order_detail_screen.dart';
import 'features/orders/orders_screen.dart';
import 'features/payments/payments_screen.dart';
import 'features/payments/statement_screen.dart';
import 'features/products/bulk_upload_screen.dart';
import 'features/products/product_editor_screen.dart';
import 'features/products/products_screen.dart';
import 'features/products/reorder_screen.dart';
import 'features/reports/reports_screen.dart';
import 'features/shell/shell.dart';
import 'features/store/store_edit_screen.dart';
import 'features/store/store_screen.dart';
import 'state/providers.dart';
import 'state/session.dart';

final rootNavigatorKey = GlobalKey<NavigatorState>();

const _gatePaths = {'/login', '/boot', '/no-shop'};

/// Where the gate sends someone, or null to let them through.
///
/// Signed out → /login. Signed in → /boot while `/api/vendor/me` loads (and
/// for a fault, with Retry), /no-shop when the account runs no shop, and on
/// into the app once it answers. A section the shop's switches turn off goes
/// Home ([featureRedirect]).
String? gateRedirect({required bool signedIn, required AsyncValue<Object?> me, required String path}) {
  if (!signedIn) return path == '/login' ? null : '/login';
  if (me.hasError && !me.isLoading) {
    final target = isNoShopError(me.error) ? '/no-shop' : '/boot';
    return path == target ? null : target;
  }
  if (me.value == null) return path == '/boot' ? null : '/boot';
  if (_gatePaths.contains(path)) return '/';
  // A section switched off for this shop (Admin → Feature access) is not
  // reachable, whatever link led there.
  final v = me.value;
  return v is VendorMe ? featureRedirect(path, v) : null;
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
    redirect: (context, state) =>
        gateRedirect(signedIn: ref.read(signedInProvider), me: ref.read(vendorMeProvider), path: state.matchedLocation),
    routes: [
      GoRoute(path: '/login', builder: (_, _) => const LoginScreen()),
      GoRoute(path: '/boot', builder: (_, _) => const BootScreen()),
      GoRoute(path: '/no-shop', builder: (_, _) => const NoShopScreen()),
      // A PDF to view, print or share; the caller passes a DocumentRequest.
      GoRoute(
        path: '/document',
        parentNavigatorKey: rootNavigatorKey,
        redirect: (_, s) => s.extra is DocumentRequest ? null : '/',
        builder: (_, s) => DocumentScreen(request: s.extra! as DocumentRequest),
      ),
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => PartnerShell(shell: shell),
        branches: [
          StatefulShellBranch(
            routes: [GoRoute(path: '/', builder: (_, _) => const HomeScreen())],
          ),
          StatefulShellBranch(
            routes: [
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
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/reports',
                builder: (_, s) => ReportsScreen(tab: s.uri.queryParameters['tab']),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/payments',
                builder: (_, _) => const PaymentsScreen(),
                routes: [
                  GoRoute(
                    path: ':id',
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, s) => StatementScreen(settlementId: s.pathParameters['id']!),
                  ),
                ],
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/more',
                builder: (_, _) => const MoreScreen(),
                routes: [
                  GoRoute(
                    path: 'settings',
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, _) => const SettingsScreen(),
                  ),
                  GoRoute(
                    path: 'offers',
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, _) => const OffersScreen(),
                    routes: [
                      GoRoute(
                        path: 'new',
                        parentNavigatorKey: rootNavigatorKey,
                        builder: (_, _) => const OfferEditorScreen(),
                      ),
                      GoRoute(
                        path: 'edit',
                        parentNavigatorKey: rootNavigatorKey,
                        redirect: (_, s) => s.extra is Offer ? null : '/more/offers',
                        builder: (_, s) => OfferEditorScreen(offer: s.extra! as Offer),
                      ),
                    ],
                  ),
                  GoRoute(
                    path: 'marketing',
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, _) => const MarketingScreen(),
                    routes: [
                      GoRoute(
                        path: 'new',
                        parentNavigatorKey: rootNavigatorKey,
                        builder: (_, s) => NewMarketingScreen(kind: s.uri.queryParameters['kind']),
                      ),
                      GoRoute(
                        path: ':id',
                        parentNavigatorKey: rootNavigatorKey,
                        builder: (_, s) => MarketingDetailScreen(
                          id: s.pathParameters['id']!,
                          initial: s.extra is MarketingRequest ? s.extra! as MarketingRequest : null,
                        ),
                      ),
                    ],
                  ),
                  GoRoute(
                    path: 'reviews',
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, _) => const ReviewsScreen(),
                  ),
                  GoRoute(
                    path: 'support',
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, _) => const SupportScreen(),
                    routes: [
                      GoRoute(
                        path: 'new',
                        parentNavigatorKey: rootNavigatorKey,
                        builder: (_, s) => NewTicketScreen(
                          orderId: s.uri.queryParameters['order'],
                          orderCode: s.uri.queryParameters['code'],
                        ),
                      ),
                      GoRoute(
                        path: ':id',
                        parentNavigatorKey: rootNavigatorKey,
                        builder: (_, s) => TicketScreen(id: s.pathParameters['id']!),
                      ),
                    ],
                  ),
                  GoRoute(
                    path: 'notifications',
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, _) => const NotificationsScreen(),
                  ),
                  GoRoute(
                    path: 'invoices',
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, _) => const InvoicesScreen(),
                  ),
                  GoRoute(
                    path: 'store',
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, _) => const StoreScreen(),
                    routes: [
                      GoRoute(
                        path: 'edit',
                        parentNavigatorKey: rootNavigatorKey,
                        builder: (_, _) => const StoreEditScreen(),
                      ),
                    ],
                  ),
                  GoRoute(
                    path: 'products',
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, s) => ProductsScreen(filter: s.uri.queryParameters['filter']),
                    routes: [
                      GoRoute(
                        path: 'new',
                        parentNavigatorKey: rootNavigatorKey,
                        builder: (_, _) => const ProductEditorScreen(),
                      ),
                      GoRoute(
                        path: 'reorder',
                        parentNavigatorKey: rootNavigatorKey,
                        builder: (_, _) => const ReorderScreen(),
                      ),
                      GoRoute(
                        path: 'bulk',
                        parentNavigatorKey: rootNavigatorKey,
                        builder: (_, _) => const BulkUploadScreen(),
                      ),
                      GoRoute(
                        path: ':id',
                        parentNavigatorKey: rootNavigatorKey,
                        builder: (_, s) => ProductEditorScreen(itemId: s.pathParameters['id']),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
});
