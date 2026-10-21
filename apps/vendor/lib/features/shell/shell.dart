import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/i18n.dart';
import '../../core/push.dart';
import '../../core/ring.dart';
import '../../core/update_check.dart';
import '../../router.dart';
import '../../state/orders.dart';
import '../../state/providers.dart';

/// The five tabs: Home · Orders · Reports · Payments · More. Starts push and
/// runs the update check once the vendor is inside the app.
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
      PushService(
        ref.read(supabaseProvider).auth,
        ref.read(accountRepoProvider),
        ref.read(routerProvider),
      ).start();
      final v = await ref.read(accountRepoProvider).appVersion();
      final ctx = rootNavigatorKey.currentContext;
      if (v != null && ctx != null && ctx.mounted) {
        await showUpdatePrompt(ctx, v, hi: isHindi(ref));
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final shell = widget.shell;
    // The board keeps polling on every tab, and any order still New rings
    // until it moves on (the push extension covers the app being closed).
    ref.listen(boardProvider, (_, next) {
      final orders = next.value?.orders;
      if (orders == null) return;
      ref.read(boardRingerProvider.notifier).sync(
            orders,
            title: (_) => trNow(ref, 'New order 🔔', 'नया ऑर्डर 🔔'),
            body: (o) => trNow(ref, 'Order ${o.code} · ${o.itemCount} items is waiting for you to accept.',
                'ऑर्डर ${o.code} · ${o.itemCount} आइटम आपके स्वीकार करने का इंतज़ार कर रहा है।'),
          );
    });
    return Scaffold(
      body: shell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex,
        onDestinationSelected: (i) => shell.goBranch(i, initialLocation: i == shell.currentIndex),
        destinations: [
          NavigationDestination(
            icon: const Icon(Icons.space_dashboard_outlined),
            selectedIcon: const Icon(Icons.space_dashboard_rounded),
            label: tr(ref, 'Home', 'होम'),
          ),
          NavigationDestination(
            icon: const Icon(Icons.receipt_long_outlined),
            selectedIcon: const Icon(Icons.receipt_long_rounded),
            label: tr(ref, 'Orders', 'ऑर्डर'),
          ),
          NavigationDestination(
            icon: const Icon(Icons.bar_chart_outlined),
            selectedIcon: const Icon(Icons.bar_chart_rounded),
            label: tr(ref, 'Reports', 'रिपोर्ट'),
          ),
          NavigationDestination(
            icon: const Icon(Icons.account_balance_wallet_outlined),
            selectedIcon: const Icon(Icons.account_balance_wallet_rounded),
            label: tr(ref, 'Payments', 'भुगतान'),
          ),
          NavigationDestination(
            icon: const Icon(Icons.grid_view_outlined),
            selectedIcon: const Icon(Icons.grid_view_rounded),
            label: tr(ref, 'More', 'और'),
          ),
        ],
      ),
    );
  }
}
