import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/manager_me.dart';
import '../state/prefs.dart';
import '../state/session.dart';
import '../theme/app_theme.dart';

/// The zone every screen is filtered to, or null for "All my zones". A saved
/// zone the manager no longer has is ignored rather than trusted — the server
/// would refuse it anyway.
final activeZoneProvider = Provider<Zone?>((ref) {
  final me = ref.watch(managerMeProvider).value;
  final id = ref.watch(zoneFilterProvider);
  if (me == null || id == null) return null;
  for (final z in me.zones.zones) {
    if (z.id == id) return z;
  }
  return null;
});

/// "All my zones ▾" — opens a sheet of the manager's zones, grouped by city.
class ZonePickerChip extends ConsumerWidget {
  const ZonePickerChip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(managerMeProvider).value;
    final zone = ref.watch(activeZoneProvider);
    final c = context.colors;
    if (me == null || me.hasNoZones) return const SizedBox.shrink();
    final label = zone?.name ?? (me.zones.all ? 'All zones' : 'All my zones');
    return Semantics(
      button: true,
      label: 'Zone: $label',
      child: InkWell(
        key: const Key('zone-picker'),
        borderRadius: BorderRadius.circular(999),
        onTap: () => _open(context, ref, me),
        child: Container(
          constraints: const BoxConstraints(minHeight: 36),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            color: c.surface,
            border: Border.all(color: c.line),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.place_outlined, size: 16, color: c.accent),
              const SizedBox(width: 6),
              Text(label, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: c.ink)),
              Icon(Icons.expand_more, size: 18, color: c.muted),
            ],
          ),
        ),
      ),
    );
  }

  void _open(BuildContext context, WidgetRef ref, ManagerMe me) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) {
        final current = ref.read(zoneFilterProvider);
        void pick(String? id) {
          ref.read(zoneFilterProvider.notifier).set(id);
          Navigator.pop(sheet);
        }

        return SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: [
              ListTile(
                leading: const Icon(Icons.layers_outlined),
                title: Text(me.zones.all ? 'All zones' : 'All my zones'),
                trailing: current == null ? const Icon(Icons.check) : null,
                onTap: () => pick(null),
              ),
              for (final city in me.zones.cities) ...[
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                  child: Text(city.name.toUpperCase(),
                      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.6, color: context.colors.muted)),
                ),
                for (final z in city.zones)
                  ListTile(
                    leading: const Icon(Icons.place_outlined),
                    title: Text(z.name),
                    trailing: current == z.id ? const Icon(Icons.check) : null,
                    onTap: () => pick(z.id),
                  ),
              ],
            ],
          ),
        );
      },
    );
  }
}

/// Shown wherever data would be, for a manager with no zones assigned.
class NoZonesNotice extends ConsumerWidget {
  const NoZonesNotice({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Container(
      key: const Key('no-zones'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: c.dealSoft,
        borderRadius: BorderRadius.circular(radiusBlock),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.location_off_outlined, color: c.deal),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('No zones assigned',
                    style: TextStyle(fontWeight: FontWeight.w800, color: c.deal, fontSize: 15)),
                const SizedBox(height: 4),
                Text(
                  'You won\'t see any orders, riders or vendors until an admin assigns you a zone on Team.',
                  style: TextStyle(color: c.ink, fontSize: 13.5, height: 1.4),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
