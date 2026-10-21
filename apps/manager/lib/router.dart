import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/i18n.dart';
import 'features/auth/gate_screens.dart';
import 'features/auth/login_screen.dart';
import 'features/home/home_screen.dart';
import 'features/more/more_screen.dart';
import 'features/profile/account_screens.dart';
import 'features/profile/profile_screen.dart';
import 'features/settings/settings_screen.dart';
import 'features/shell/manager_shell.dart';
import 'features/shell/nav.dart';
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
Widget _pending({required String en, required String hi, required IconData icon, required int phase}) =>
    Consumer(builder: (_, ref, _) => PhasePlaceholder(title: tr(ref, en, hi), icon: icon, phase: phase));

/// A main tab a later phase delivers (no back button: it is a tab).
Widget _pendingTab(TabDef t, int phase, String whatEn, String whatHi) => Consumer(
      builder: (_, ref, _) => Scaffold(
        appBar: AppBar(title: Text(tr(ref, t.en, t.hi))),
        body: PhasePlaceholder(
          showAppBar: false,
          title: tr(ref, t.en, t.hi),
          icon: t.icon,
          phase: phase,
          what: tr(ref, whatEn, whatHi),
        ),
      ),
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
              builder: (_, _) => _pendingTab(tabs[1], 3, 'Every order across your zones, with search, filters, timelines and actions.',
                  'आपके ज़ोन के सभी ऑर्डर — खोज, फ़िल्टर, टाइमलाइन और कार्रवाई।'),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/live',
              builder: (_, _) => _pendingTab(tabs[2], 3, 'Live map of riders and active deliveries, delays and reassignment.',
                  'राइडर और चल रही डिलीवरी का लाइव मैप, देरी और राइडर बदलना।'),
            ),
          ]),
          StatefulShellBranch(routes: [
            GoRoute(
              path: '/finance',
              builder: (_, _) => _pendingTab(tabs[3], 6, 'Sales, commission, settlements, payouts and reconciliation.',
                  'बिक्री, कमीशन, सेटलमेंट, भुगतान और मिलान।'),
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
                for (final m in moreItems.where((m) => m.phase != null))
                  GoRoute(
                    path: m.path.substring('/more/'.length),
                    parentNavigatorKey: rootNavigatorKey,
                    builder: (_, _) => _pending(en: m.en, hi: m.hi, icon: m.icon, phase: m.phase!),
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
      GoRoute(path: '/boot', builder: (_, _) => const BootScreen()),
      GoRoute(path: '/not-manager', builder: (_, _) => const NotManagerScreen()),
      ...appRoutes(),
    ],
  );
});
