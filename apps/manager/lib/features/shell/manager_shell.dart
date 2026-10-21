import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../state/session.dart';
import 'nav.dart';

/// The bottom bar: Home · Orders · Live · Finance · More, minus the tabs this
/// person has no permission for. The branches always exist (go_router needs a
/// fixed list); only the destinations shown change.
class ManagerShell extends ConsumerWidget {
  const ManagerShell({super.key, required this.shell});

  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(managerMeProvider).value;
    final visible = me == null ? [tabs.first, tabs.last] : tabsFor(me);
    final current = tabs[shell.currentIndex];
    final selected = visible.indexWhere((t) => t.path == current.path);

    return Scaffold(
      body: shell,
      bottomNavigationBar: NavigationBar(
        key: const Key('manager-tabs'),
        selectedIndex: selected < 0 ? 0 : selected,
        onDestinationSelected: (i) {
          final branch = tabs.indexOf(visible[i]);
          shell.goBranch(branch, initialLocation: branch == shell.currentIndex);
        },
        destinations: [
          for (final t in visible)
            NavigationDestination(
              icon: Icon(t.icon),
              selectedIcon: Icon(t.selectedIcon),
              label: t.en,
            ),
        ],
      ),
    );
  }
}
