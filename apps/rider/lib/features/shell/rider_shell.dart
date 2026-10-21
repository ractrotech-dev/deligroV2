import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/rider_me.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../home/home_screen.dart';
import '../more/more_screen.dart';

/// One tab of the bottom bar and the routes behind it.
class RiderTab {
  const RiderTab({
    required this.id,
    required this.label,
    required this.icon,
    required this.selectedIcon,
    required this.route,
  });

  /// One of [riderTabOrder].
  final String id;
  final String label;
  final IconData icon;
  final IconData selectedIcon;

  /// The tab's root route (`/home`) with its sub-routes under it.
  final GoRoute route;
}

/// The bar's order, whichever tabs a phase has registered.
const riderTabOrder = ['home', 'jobs', 'earnings', 'history', 'more'];

final _home = RiderTab(
  id: 'home',
  label: 'Home',
  icon: Icons.home_outlined,
  selectedIcon: Icons.home_rounded,
  route: GoRoute(path: '/home', builder: (_, _) => const HomeScreen()),
);

final _more = RiderTab(
  id: 'more',
  label: 'More',
  icon: Icons.more_horiz_rounded,
  selectedIcon: Icons.more_horiz_rounded,
  route: moreRoute,
);

/// The tabs in the bar. Phase 1 registers Home and More; Jobs, Earnings and
/// History add theirs to this list in their phases (the order is fixed by
/// [riderTabOrder], not by where they are added).
final List<RiderTab> riderTabs =
    ([_home, _more]..sort(
          (a, b) => riderTabOrder
              .indexOf(a.id)
              .compareTo(riderTabOrder.indexOf(b.id)),
        ))
        .toList(growable: false);

/// The frame around the tabs: the offline banner, the page, the bottom bar.
class RiderShell extends ConsumerStatefulWidget {
  const RiderShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  @override
  ConsumerState<RiderShell> createState() => _RiderShellState();
}

class _RiderShellState extends ConsumerState<RiderShell>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// `/api/rider/me` is read again each time the app comes back to the front,
  /// so the rider never acts on a status that is hours old.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) ref.invalidate(meProvider);
  }

  @override
  Widget build(BuildContext context) {
    final shell = widget.shell;
    final banner = showsOfflineBanner(ref.watch(meProvider));
    return Scaffold(
      body: Column(
        children: [
          const OfflineBanner(),
          // The banner already stands clear of the status bar.
          Expanded(
            child: MediaQuery.removePadding(
              context: context,
              removeTop: banner,
              child: shell,
            ),
          ),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex,
        onDestinationSelected: (i) =>
            shell.goBranch(i, initialLocation: i == shell.currentIndex),
        destinations: [
          for (final t in riderTabs)
            NavigationDestination(
              icon: Icon(t.icon),
              selectedIcon: Icon(t.selectedIcon),
              label: t.label,
            ),
        ],
      ),
    );
  }
}

/// Whether the last answer from `/api/rider/me` was "no connection".
bool showsOfflineBanner(AsyncValue<RiderMe> me) {
  final error = me.error;
  return me.hasError && error is ApiException && error.status == 0;
}

/// Shown when the last `/api/rider/me` could not reach the server but the
/// rider's own data from before is still on screen (R15). Anything else the
/// server says (401, 403, 404, 503) is the router's business, not a banner.
class OfflineBanner extends ConsumerWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProvider);
    if (!showsOfflineBanner(me)) return const SizedBox.shrink();
    final c = context.colors;
    return Material(
      color: c.pop,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 6, 8, 6),
          child: Row(
            children: [
              Icon(Icons.cloud_off_rounded, size: 18, color: c.popInk),
              const SizedBox(width: 10),
              Expanded(
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    "You're offline — showing your last status",
                    style: TextStyle(
                      color: c.popInk,
                      fontWeight: FontWeight.w700,
                      fontSize: 13.5,
                    ),
                  ),
                ),
              ),
              if (me.isLoading)
                const Padding(
                  padding: EdgeInsets.all(12),
                  child: SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                )
              else
                TextButton(
                  key: const Key('offline-retry'),
                  onPressed: () => ref.invalidate(meProvider),
                  style: TextButton.styleFrom(
                    foregroundColor: c.popInk,
                    minimumSize: const Size(48, 40),
                  ),
                  child: Text('Retry'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
