import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../models/alerts.dart';
import '../../models/manager_me.dart' show Zone;
import '../../models/outcome.dart';
import '../../state/alerts.dart';
import '../../state/inbox.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/polling.dart';
import '../../widgets/zone_picker.dart';
import 'alert_labels.dart';
import 'raise_incident_sheet.dart';

/// Alerts (§14, §6.7–6.8): what needs a person right now, critical first —
/// open, acknowledged or resolved; acknowledge, resolve with a note, or open
/// the order, vendor, rider or ticket it is about. Raise an incident from
/// here. Re-asks every 15 s while on screen.
class AlertsScreen extends ConsumerStatefulWidget {
  const AlertsScreen({super.key});

  @override
  ConsumerState<AlertsScreen> createState() => _AlertsScreenState();
}

class _AlertsScreenState extends ConsumerState<AlertsScreen> {
  AlertFilters _filters = const AlertFilters();
  AlertCounts _counts = const AlertCounts();

  Future<void> _pickKinds() async {
    final picked = await showModalBottomSheet<Set<AlertKind>>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) => _KindsSheet(initial: _filters.kinds),
    );
    if (picked != null && mounted) setState(() => _filters = _filters.copyWith(kinds: picked));
  }

  Future<void> _raise(AlertFilters eff) async {
    final draft = await showRaiseIncidentSheet(context);
    if (draft == null || !mounted) return;
    await _sendIncident(draft, eff);
  }

  Future<void> _sendIncident(IncidentDraft draft, AlertFilters eff) async {
    final Outcome<Alert> out;
    try {
      out = await ref.read(alertsRepoProvider).raiseIncident(draft);
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text("The incident wasn't raised. ${e.friendly}"),
          duration: const Duration(seconds: 8),
          action: SnackBarAction(label: 'Retry', onPressed: () => _sendIncident(draft, eff)),
        ));
      return;
    }
    if (!mounted) return;
    await ref.read(alertListProvider(eff).notifier).refresh();
    ref.invalidate(unreadCountProvider);
    if (mounted) showSnack(context, out is Refused<Alert> ? alertRefusalText(out) : 'Incident raised. Managers in the zone are alerted.');
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final zone = ref.watch(activeZoneProvider);
    final eff = _filters.copyWith(zoneId: zone?.id);
    final value = ref.watch(alertListProvider(eff));
    final data = value.value;
    if (data != null) _counts = data.counts;
    final zoneNames = <String, String>{for (final z in me?.zones.zones ?? const <Zone>[]) z.id: z.name};

    Widget seg(AlertStatus s, String label) => Padding(
          padding: const EdgeInsets.only(right: 8),
          child: ChoiceChip(
            key: Key('alerts-seg-${s.wire}'),
            label: Text(label),
            selected: _filters.status == s,
            onSelected: (_) => setState(() => _filters = _filters.copyWith(status: s)),
          ),
        );

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Alerts'),
        backgroundColor: c.bg,
        actions: [
          IconButton(
            key: const Key('alerts-kinds'),
            tooltip: 'Filter by kind',
            onPressed: _pickKinds,
            icon: Badge(
              isLabelVisible: _filters.kinds.isNotEmpty,
              label: Text('${_filters.kinds.length}'),
              backgroundColor: c.accent,
              textColor: c.onAccent,
              child: const Icon(Icons.tune),
            ),
          ),
          const Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip()),
        ],
      ),
      floatingActionButton: (me?.hasNoZones ?? false)
          ? null
          : FloatingActionButton.extended(
              key: const Key('alerts-raise-incident'),
              backgroundColor: c.accent,
              foregroundColor: c.onAccent,
              onPressed: () => _raise(eff),
              icon: const Icon(Icons.report_outlined),
              label: const Text('Raise incident'),
            ),
      body: (me?.hasNoZones ?? false)
          ? const Padding(padding: EdgeInsets.all(16), child: NoZonesNotice())
          : Polling(
              interval: alertsRefresh,
              onTick: () => ref.read(alertListProvider(eff).notifier).refresh(),
              child: Column(
                children: [
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                    child: Row(children: [
                      seg(AlertStatus.open, 'Open (${_counts.open})'),
                      seg(AlertStatus.acknowledged, 'Acknowledged (${_counts.acknowledged})'),
                      seg(AlertStatus.resolved, 'Resolved'),
                    ]),
                  ),
                  if (_counts.critical > 0 && _filters.status != AlertStatus.resolved)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 6),
                      child: Row(children: [
                        Icon(Icons.priority_high, size: 16, color: c.deal),
                        const SizedBox(width: 4),
                        Text('${_counts.critical} critical', style: TextStyle(color: c.deal, fontWeight: FontWeight.w700)),
                      ]),
                    ),
                  Expanded(child: _list(value, eff, zoneNames)),
                ],
              ),
            ),
    );
  }

  Widget _list(AsyncValue<AlertList> value, AlertFilters eff, Map<String, String> zoneNames) {
    final data = value.value;
    if (data == null) {
      if (value.hasError) {
        final e = value.error!;
        if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
        return ErrorRetry(error: e, onRetry: () => ref.invalidate(alertListProvider(eff)));
      }
      return const Center(child: CircularProgressIndicator());
    }
    Future<void> pull() => ref.read(alertListProvider(eff).notifier).refresh();
    if (data.items.isEmpty) {
      return RefreshIndicator(
        onRefresh: pull,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            EmptyLine(switch (_filters.status) {
              AlertStatus.open => 'Nothing needs attention right now.',
              AlertStatus.acknowledged => 'No acknowledged alerts.',
              _ => 'No resolved alerts in the last 7 days.',
            }),
          ],
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: pull,
      child: ListView.separated(
        key: const Key('alerts-list'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 96),
        itemCount: data.items.length + (data.hasMore ? 1 : 0),
        separatorBuilder: (_, _) => const SizedBox(height: 10),
        itemBuilder: (context, i) {
          if (i == data.items.length) {
            return Center(
              child: TextButton(
                onPressed: () => ref.read(alertListProvider(eff).notifier).loadMore(),
                child: Text(data.loadMoreFailed ? "Couldn't load more — tap to retry" : 'Load more'),
              ),
            );
          }
          final a = data.items[i];
          return AlertCard(
            alert: a,
            zoneName: a.zoneId == null ? 'All zones' : zoneNames[a.zoneId],
            onAct: (action) => runAlertAction(
              context,
              ref,
              a,
              action,
              (x) => ref.read(alertListProvider(eff).notifier).act(a.id, x),
            ),
          );
        },
      ),
    );
  }
}

class _KindsSheet extends StatefulWidget {
  const _KindsSheet({required this.initial});
  final Set<AlertKind> initial;

  @override
  State<_KindsSheet> createState() => _KindsSheetState();
}

class _KindsSheetState extends State<_KindsSheet> {
  late Set<AlertKind> _kinds = {...widget.initial};

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Show these kinds', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)),
            const SizedBox(height: 10),
            Wrap(spacing: 8, runSpacing: 6, children: [
              for (final k in AlertKind.values.where((k) => k != AlertKind.unknown))
                FilterChip(
                  key: Key('alert-kind-${k.wire}'),
                  label: Text(k.label),
                  selected: _kinds.contains(k),
                  onSelected: (on) => setState(() => on ? _kinds.add(k) : _kinds.remove(k)),
                ),
            ]),
            const SizedBox(height: 16),
            Row(children: [
              TextButton(onPressed: () => setState(() => _kinds = {}), child: const Text('All kinds')),
              const Spacer(),
              FilledButton(onPressed: () => Navigator.pop(context, _kinds), child: const Text('Show')),
            ]),
          ],
        ),
      ),
    );
  }
}
