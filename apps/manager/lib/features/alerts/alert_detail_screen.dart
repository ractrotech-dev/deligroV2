import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../models/alerts.dart';
import '../../models/manager_me.dart' show Zone;
import '../../state/alerts.dart';
import '../../state/inbox.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'alert_labels.dart';

/// One alert and what happened to it: opened, acknowledged, reopened,
/// resolved or cleared, by whom, with the notes.
class AlertDetailScreen extends ConsumerWidget {
  const AlertDetailScreen({super.key, required this.alertId});
  final String alertId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final zoneNames = <String, String>{for (final z in me?.zones.zones ?? const <Zone>[]) z.id: z.name};
    final when = DateFormat('d MMM, h:mm a');
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Alert'), backgroundColor: c.bg),
      body: AsyncView(
        value: ref.watch(alertDetailProvider(alertId)),
        onRetry: () => ref.invalidate(alertDetailProvider(alertId)),
        builder: (d) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
          children: [
            AlertCard(
              alert: d.alert,
              zoneName: d.alert.zoneId == null ? 'All zones' : zoneNames[d.alert.zoneId],
              onAct: (action) => runAlertAction(context, ref, d.alert, action, (a) async {
                final out = await ref.read(alertsRepoProvider).act(alertId, a);
                ref.invalidate(alertDetailProvider(alertId));
                ref.invalidate(unreadCountProvider);
                return out;
              }),
            ),
            const SizedBox(height: 18),
            Text('History', style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15)),
            const SizedBox(height: 8),
            if (d.history.isEmpty) const EmptyLine('No history yet.'),
            for (final h in d.history)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.circle, size: 9, color: h.event == 'resolved' || h.event == 'cleared' ? c.green : c.muted),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            [h.label, if (h.actor != null) 'by ${h.actor!.name}'].join(' '),
                            style: TextStyle(color: c.ink, fontWeight: FontWeight.w600),
                          ),
                          if (h.note != null) Text('"${h.note}"', style: TextStyle(color: c.ink, fontSize: 13)),
                          if (h.at != null)
                            Text(when.format(h.at!.toLocal()), style: TextStyle(color: c.muted, fontSize: 12)),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            if (d.alert.isResolved && d.alert.kind != AlertKind.incident)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  'If the problem comes back, this alert reopens on its own.',
                  style: TextStyle(color: c.muted, fontSize: 12.5),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
