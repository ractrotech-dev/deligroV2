import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/phase_placeholder.dart';
import '../../widgets/zone_picker.dart';

/// Home: greeting, zone picker, and — from Phase 2 — the eighteen-figure
/// dashboard. A manager with no zones is told so here, first.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(managerMeProvider).value;
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      body: SafeArea(
        child: CustomScrollView(
          slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
              sliver: SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(tr(ref, 'Deligro · Operations', 'Deligro · संचालन'),
                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.muted)),
                    const SizedBox(height: 4),
                    Text(
                      tr(ref, 'Hi, ${me?.profile.displayName ?? ''}', 'नमस्ते, ${me?.profile.displayName ?? ''}'),
                      style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: c.ink, letterSpacing: -0.4),
                    ),
                    const SizedBox(height: 12),
                    const ZonePickerChip(),
                    if (me?.hasNoZones ?? false) ...[const SizedBox(height: 12), const NoZonesNotice()],
                  ],
                ),
              ),
            ),
            SliverFillRemaining(
              hasScrollBody: false,
              child: PhasePlaceholder(
                showAppBar: false,
                title: tr(ref, 'Dashboard', 'डैशबोर्ड'),
                icon: Icons.space_dashboard_outlined,
                phase: 2,
                what: tr(ref, 'Sales, orders, vendors, riders, money and queues — eighteen live figures.',
                    'बिक्री, ऑर्डर, वेंडर, राइडर, पैसा और कतारें — अठारह लाइव आँकड़े।'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
