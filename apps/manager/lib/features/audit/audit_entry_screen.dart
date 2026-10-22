import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/entity_routes.dart';
import '../../models/audit.dart';
import '../../models/manager_me.dart' show Zone;
import '../../state/audit.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'audit_log_screen.dart';

/// One audit entry in full: what, who, when, where, why, and every field it
/// changed — before beside after.
class AuditEntryScreen extends ConsumerWidget {
  const AuditEntryScreen({super.key, required this.entryId});
  final int entryId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final catalog = ref.watch(auditActionsProvider).value ?? const <AuditActionDef>[];
    final zones = <String, String>{
      for (final z in ref.watch(managerMeProvider).value?.zones.zones ?? const <Zone>[]) z.id: z.name,
    };
    final when = DateFormat('d MMM y, h:mm:ss a');
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Audit entry'), backgroundColor: c.bg),
      body: AsyncView(
        value: ref.watch(auditEntryProvider(entryId)),
        onRetry: () => ref.invalidate(auditEntryProvider(entryId)),
        builder: (d) {
          final e = d.entry;
          final route = e.entityId.isEmpty ? null : routeForEntity(e.entityType, e.entityId);
          final facts = <(String, String)>[
            ('Action', auditActionLabel(e.action, catalog)),
            ('Done by', '${e.actor.name} · ${e.actor.roleLabel}'),
            if (e.at != null) ('When', when.format(e.at!.toLocal())),
            ('Record', '${auditEntityLabel(e.entityType)} ${e.entityId}'),
            ('Zone', e.zoneId == null ? 'All zones' : (zones[e.zoneId] ?? e.zoneId!)),
            ('Reason', e.reason ?? '—'),
            if (e.clientActionId != null) ('Request id', e.clientActionId!),
          ];
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            children: [
              for (final f in facts)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 5),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    SizedBox(width: 96, child: Text(f.$1, style: TextStyle(color: c.muted, fontSize: 13))),
                    Expanded(child: Text(f.$2, style: TextStyle(color: c.ink, fontSize: 14))),
                  ]),
                ),
              if (route != null && !route.startsWith('/alerts')) ...[
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerLeft,
                  child: OutlinedButton.icon(
                    key: const Key('audit-open-entity'),
                    onPressed: () => GoRouter.maybeOf(context)?.push(route),
                    icon: const Icon(Icons.open_in_new, size: 18),
                    label: Text('Open ${auditEntityLabel(e.entityType).toLowerCase()}'),
                  ),
                ),
              ],
              const SizedBox(height: 18),
              Text('What changed', style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15)),
              const SizedBox(height: 8),
              if (d.diff.isEmpty)
                const EmptyLine('No field values were recorded for this action.')
              else
                Table(
                  columnWidths: const {0: FlexColumnWidth(1.1), 1: FlexColumnWidth(1), 2: FlexColumnWidth(1)},
                  border: TableBorder(horizontalInside: BorderSide(color: c.line)),
                  children: [
                    TableRow(children: [
                      for (final h in const ['Field', 'Before', 'After'])
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Text(h, style: TextStyle(color: c.muted, fontSize: 12, fontWeight: FontWeight.w700)),
                        ),
                    ]),
                    for (final r in d.diff)
                      TableRow(children: [
                        Padding(
                          key: Key('diff-${r.path}'),
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Text(r.path, style: dataStyle(context, size: 12)),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Text(r.before, style: TextStyle(color: c.deal, fontSize: 13)),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Text(r.after, style: TextStyle(color: c.green, fontSize: 13)),
                        ),
                      ]),
                  ],
                ),
            ],
          );
        },
      ),
    );
  }
}
