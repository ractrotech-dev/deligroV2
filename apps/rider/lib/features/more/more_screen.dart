import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/money.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/rows.dart';
import '../cash/cash_screen.dart';
import '../cash/cash_strip.dart';
import '../profile/profile_screen.dart' show profileRoute;
import '../performance/performance_screen.dart';
import '../settings/privacy_screen.dart';
import '../settings/settings_screen.dart';

/// The More tab and the pages under it. The tab bar stays under every one.
final moreRoute = GoRoute(
  path: '/more',
  builder: (_, _) => const MoreScreen(),
  routes: [
    cashRoute,
    profileRoute,
    GoRoute(path: 'settings', builder: (_, _) => const SettingsScreen()),
    GoRoute(path: 'privacy', builder: (_, _) => const PrivacyScreen()),
    GoRoute(path: 'performance', builder: (_, _) => const PerformanceScreen()),
  ],
);

/// Everything that is not a tab. Settings is all Phase 1 puts here; later
/// phases add their own rows (profile, documents, help).
class MoreScreen extends ConsumerWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProvider).value;
    final c = context.colors;
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: [
            Text(
              'More',
              style: Theme.of(context).textTheme.headlineSmall,
            ),
            if (me != null && (me.phone ?? '').isNotEmpty) ...[
              const SizedBox(height: 4),
              Text(
                me.phone!,
                style: dataStyle(
                  context,
                  size: 14,
                  weight: FontWeight.w500,
                ).copyWith(color: c.muted),
              ),
            ],
            const SizedBox(height: 16),
            RowsCard(
              children: [
                NavRow(
                  key: const Key('row-cash'),
                  icon: Icons.payments_outlined,
                  title: 'Cash',
                  subtitle: 'Cash you collect and deposit',
                  trailing: _CashBadge(amount: pendingCash(ref)),
                  onTap: () => context.push(cashPath),
                ),
                NavRow(
                  key: const Key('row-performance'),
                  icon: Icons.insights_outlined,
                  title: 'Performance',
                  subtitle: 'Targets, ratings, monthly report',
                  onTap: () => context.push(performancePath),
                ),
                NavRow(
                  key: const Key('row-profile'),
                  icon: Icons.badge_outlined,
                  title: 'Profile & documents',
                  subtitle: 'Your details, documents, payout account',
                  trailing: (me?.profile?.needsAttention ?? false)
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              key: const Key('profile-dot'),
                              width: 10,
                              height: 10,
                              decoration: BoxDecoration(color: c.deal, shape: BoxShape.circle),
                            ),
                            Icon(Icons.chevron_right_rounded, color: c.muted),
                          ],
                        )
                      : null,
                  onTap: () => context.push('/more/profile'),
                ),
                NavRow(
                  key: const Key('row-settings'),
                  icon: Icons.settings_outlined,
                  title: 'Settings',
                  subtitle: 'Updates, privacy, sign out',
                  onTap: () => context.push('/more/settings'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// The cash the rider holds, on the Cash row; a chevron alone when none.
class _CashBadge extends StatelessWidget {
  const _CashBadge({required this.amount});

  final int? amount;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final a = amount;
    if (a == null) return Icon(Icons.chevron_right_rounded, color: c.muted);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          key: const Key('cash-badge'),
          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
          decoration: BoxDecoration(
            color: c.accentSoft,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Text(
            money(a),
            style: TextStyle(
              color: c.accentInk,
              fontSize: 13,
              fontWeight: FontWeight.w800,
            ),
          ),
        ),
        Icon(Icons.chevron_right_rounded, color: c.muted),
      ],
    );
  }
}
