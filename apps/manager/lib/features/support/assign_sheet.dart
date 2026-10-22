import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/tickets.dart';
import '../../state/support.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';

/// Picks who a ticket goes to (a manager in its zone or an admin) and which
/// team. Returns null when dismissed.
Future<TicketAssign?> showAssignSheet(BuildContext context, {required TicketDetail ticket}) =>
    showModalBottomSheet<TicketAssign>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _AssignSheet(ticket: ticket),
    );

class _AssignSheet extends ConsumerStatefulWidget {
  const _AssignSheet({required this.ticket});
  final TicketDetail ticket;

  @override
  ConsumerState<_AssignSheet> createState() => _AssignSheetState();
}

class _AssignSheetState extends ConsumerState<_AssignSheet> {
  late String? _assignee = widget.ticket.assignee?.id;
  late TicketTeam? _team = widget.ticket.team;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final value = ref.watch(ticketAssigneesProvider(widget.ticket.zoneId));
    final changed = _assignee != widget.ticket.assignee?.id || _team != widget.ticket.team;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Assign ticket #${widget.ticket.summary.number}',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)),
              const SizedBox(height: 4),
              Text('Managers who handle support in this zone, and admins.',
                  style: TextStyle(color: c.muted, fontSize: 13)),
              const SizedBox(height: 8),
              Flexible(
                child: AsyncView(
                  value: value,
                  onRetry: () => ref.invalidate(ticketAssigneesProvider(widget.ticket.zoneId)),
                  builder: (list) => ListView(
                    shrinkWrap: true,
                    children: [
                      RadioGroup<String?>(
                        groupValue: _assignee,
                        onChanged: (v) => setState(() => _assignee = v),
                        child: Column(
                          children: [
                            RadioListTile<String?>(
                              key: const Key('assignee-none'),
                              value: null,
                              title: Text('Nobody yet', style: TextStyle(color: c.ink)),
                            ),
                            for (final s in list.staff)
                              RadioListTile<String?>(
                                key: Key('assignee-${s.id}'),
                                value: s.id,
                                title: Text(s.name, style: TextStyle(color: c.ink, fontWeight: FontWeight.w600)),
                                subtitle: Text(
                                  '${s.role == 'admin' ? 'Admin' : 'Manager'} · ${s.openAssigned} open',
                                  style: TextStyle(color: c.muted, fontSize: 12.5),
                                ),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text('Team', style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 8,
                        runSpacing: 6,
                        children: [
                          for (final t in list.teams.isEmpty ? TicketTeam.values : list.teams)
                            ChoiceChip(
                              key: Key('assign-team-${t.wire}'),
                              label: Text(t.label),
                              selected: _team == t,
                              onSelected: (on) => setState(() => _team = on ? t : null),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 12),
              FilledButton(
                key: const Key('assign-save'),
                onPressed: changed
                    ? () => Navigator.pop(context, TicketAssign(assigneeId: _assignee, team: _team))
                    : null,
                child: const Text('Save'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
