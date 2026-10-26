import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/feature_gates.dart';
import '../../core/push.dart';
import '../../core/ring.dart';
import '../../core/update_check.dart';
import '../../router.dart';
import '../../state/growth.dart';
import '../../state/orders.dart';
import '../../state/providers.dart';
import '../../state/session.dart';

/// One tab of the bottom bar, in branch order (router.dart).
class PartnerTab {
  const PartnerTab(this.label, this.icon, this.selectedIcon, {this.feature});
  final String label;
  final IconData icon;
  final IconData selectedIcon;

  /// The shop switch that shows this tab; null = always (feature_gates.dart).
  final String? feature;
}

/// Home · Orders · Reports · Payments · More — the router's branch order.
const partnerTabs = [
  PartnerTab('Home', Icons.space_dashboard_outlined, Icons.space_dashboard_rounded),
  PartnerTab('Orders', Icons.receipt_long_outlined, Icons.receipt_long_rounded),
  PartnerTab('Reports', Icons.bar_chart_outlined, Icons.bar_chart_rounded, feature: reportsFeature),
  PartnerTab('Payments', Icons.account_balance_wallet_outlined, Icons.account_balance_wallet_rounded, feature: earningsFeature),
  PartnerTab('More', Icons.grid_view_outlined, Icons.grid_view_rounded),
];

/// The tabs (Reports and Payments only when the shop's switches allow). Starts
/// push and runs the update check once the vendor is inside the app.
class PartnerShell extends ConsumerStatefulWidget {
  const PartnerShell({super.key, required this.shell});
  final StatefulNavigationShell shell;

  @override
  ConsumerState<PartnerShell> createState() => _PartnerShellState();
}

class _PartnerShellState extends ConsumerState<PartnerShell> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      PushService(ref.read(supabaseProvider).auth, ref.read(accountRepoProvider), ref.read(routerProvider)).start();
      final v = await ref.read(accountRepoProvider).appVersion();
      final ctx = rootNavigatorKey.currentContext;
      if (v != null && ctx != null && ctx.mounted) {
        await showUpdatePrompt(ctx, v);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final shell = widget.shell;
    // Keeps the inbox polling while signed in, for the badges.
    final unread = ref.watch(unreadCountProvider);
    // The board keeps polling on every tab, and any order still New rings
    // until it moves on (the push extension covers the app being closed).
    ref.listen(boardProvider, (_, next) {
      final orders = next.value?.orders;
      if (orders == null) return;
      ref
          .read(boardRingerProvider.notifier)
          .sync(
            orders,
            title: (_) => 'New order 🔔',
            body: (o) => 'Order ${o.code} · ${o.itemCount} items is waiting for you to accept.',
          );
    });
    // Reports and Payments leave the bar when the shop's switch is off; the
    // branch indexes stay put and the router sends a deep link Home.
    final me = ref.watch(vendorMeProvider).value;
    final shown = [
      for (var i = 0; i < partnerTabs.length; i++)
        if (partnerTabs[i].feature == null || me == null || me.can(partnerTabs[i].feature!)) i,
    ];
    final selected = shown.indexOf(shell.currentIndex);
    return Scaffold(
      body: shell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: selected < 0 ? 0 : selected,
        onDestinationSelected: (i) => shell.goBranch(shown[i], initialLocation: shown[i] == shell.currentIndex),
        destinations: [
          for (final i in shown)
            if (i == partnerTabs.length - 1)
              NavigationDestination(
                icon: Badge(isLabelVisible: unread > 0, smallSize: 9, child: Icon(partnerTabs[i].icon)),
                selectedIcon: Badge(isLabelVisible: unread > 0, smallSize: 9, child: Icon(partnerTabs[i].selectedIcon)),
                label: partnerTabs[i].label,
              )
            else
              NavigationDestination(
                icon: Icon(partnerTabs[i].icon),
                selectedIcon: Icon(partnerTabs[i].selectedIcon),
                label: partnerTabs[i].label,
              ),
        ],
      ),
    );
  }
}
