import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../state/dashboard.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import 'dashboard_grid.dart';

/// Home: greeting, zone picker, and the eighteen-figure dashboard (§1). A
/// manager with no zones is told so here, first, and shown no figures.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  /// Tab roots switch tabs; everything else opens on top of Home.
  static void open(BuildContext context, String path) {
    final root = Uri.parse(path).path;
    if (root == '/orders' || root == '/live' || root == '/finance') {
      context.go(path);
    } else {
      context.push(path);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(managerMeProvider).value;
    final noZones = me?.hasNoZones ?? false;
    final c = context.colors;
    return DashboardVisibility(
      child: Scaffold(
      backgroundColor: c.bg,
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () => ref.read(dashboardProvider.notifier).refresh(),
          child: CustomScrollView(
            physics: const AlwaysScrollableScrollPhysics(),
            slivers: [
              SliverPadding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                sliver: SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Deligro · Operations',
                          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.muted)),
                      const SizedBox(height: 4),
                      Text(
                        'Hi, ${me?.profile.displayName ?? ''}',
                        style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: c.ink, letterSpacing: -0.4),
                      ),
                      const SizedBox(height: 12),
                      const ZonePickerChip(),
                      if (noZones) ...[const SizedBox(height: 12), const NoZonesNotice()],
                    ],
                  ),
                ),
              ),
              if (!noZones)
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                  sliver: const SliverToBoxAdapter(child: _Dashboard()),
                ),
              if (!noZones && (me?.isAdmin == true || me?.can('manager.reports.view') == true))
                SliverPadding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  sliver: SliverToBoxAdapter(
                    child: Material(
                      color: c.surface,
                      borderRadius: BorderRadius.circular(radiusBlock),
                      child: ListTile(
                        key: const Key('home-statistics'),
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(radiusBlock),
                          side: BorderSide(color: c.line),
                        ),
                        leading: Icon(Icons.insights_outlined, color: c.accent),
                        title: Text('Statistics',
                            style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
                        subtitle: Text(
                          'Sales by day, growth, peak hours, best vendors — and the report',
                          style: TextStyle(fontSize: 12.5, color: c.muted),
                        ),
                        trailing: Icon(Icons.chevron_right_rounded, color: c.muted),
                        onTap: () => context.push('/stats'),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    ),
    );
  }
}

class _Dashboard extends ConsumerWidget {
  const _Dashboard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    return ref.watch(dashboardProvider).when(
          skipLoadingOnRefresh: true,
          skipLoadingOnReload: true,
          loading: () => const DashboardSkeleton(),
          error: (e, _) {
            if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
            return ErrorRetry(error: e, onRetry: () => ref.invalidate(dashboardProvider));
          },
          data: (d) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DashboardGrid(
                data: d,
                onOpen: (p) => HomeScreen.open(context, p),
                canOpen: (f) => me != null && (me.isAdmin || me.can(f.permission)),
              ),
              if (d.generatedAt != null) ...[
                const SizedBox(height: 10),
                Text(
                  'Updated ${DateFormat('h:mm a').format(d.generatedAt!.toLocal())} · refreshes every 30 seconds',
                  style: TextStyle(fontSize: 12, color: c.muted),
                ),
              ],
            ],
          ),
        );
  }
}
