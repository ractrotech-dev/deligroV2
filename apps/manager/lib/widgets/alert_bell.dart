import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../state/inbox.dart';
import '../theme/app_theme.dart';
import 'polling.dart';

/// The bell on Home and Live: unread inbox items as a badge, a red dot when
/// any alert is critical. Opens the inbox. Re-asks every 30 s while on screen.
class AlertBell extends ConsumerWidget {
  const AlertBell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final count = ref.watch(unreadCountProvider).value;
    final unread = count?.unread ?? 0;
    final critical = (count?.criticalAlerts ?? 0) > 0;
    return Polling(
      interval: unreadRefresh,
      onTick: () => ref.read(unreadCountProvider.notifier).refresh(),
      child: Semantics(
        button: true,
        label: [
          'Notifications',
          if (unread > 0) '$unread unread',
          if (critical) 'critical alert open',
        ].join(', '),
        child: IconButton(
          key: const Key('alert-bell'),
          tooltip: 'Notifications',
          onPressed: () => GoRouter.maybeOf(context)?.push('/inbox'),
          icon: Stack(
            clipBehavior: Clip.none,
            children: [
              Badge(
                isLabelVisible: unread > 0,
                label: Text(unread > 99 ? '99+' : '$unread'),
                backgroundColor: c.accent,
                textColor: c.onAccent,
                child: Icon(Icons.notifications_outlined, color: c.ink),
              ),
              if (critical)
                Positioned(
                  left: -2,
                  top: -2,
                  child: Container(
                    key: const Key('alert-bell-critical'),
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(
                      color: c.deal,
                      shape: BoxShape.circle,
                      border: Border.all(color: c.bg, width: 1.5),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
