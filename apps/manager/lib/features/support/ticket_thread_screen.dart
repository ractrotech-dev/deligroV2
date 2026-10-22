import 'package:cross_file/cross_file.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../models/orders.dart' show TicketPriority;
import '../../models/outcome.dart';
import '../../models/tickets.dart';
import '../../state/session.dart';
import '../../state/tickets.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/contact_buttons.dart';
import '../../widgets/document_picker.dart';
import '../../widgets/polling.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/reason_dialog.dart';
import 'assign_sheet.dart';
import 'ticket_labels.dart';

/// One support ticket (§4.15, §11): what was raised, every reply and
/// internal note in order, its history, and what can be done next — assign,
/// change priority, escalate, resolve, close or reopen. Re-asks every 10 s
/// while open.
class TicketThreadScreen extends ConsumerWidget {
  const TicketThreadScreen({super.key, required this.ticketId});
  final String ticketId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final value = ref.watch(ticketThreadProvider(ticketId));
    final t = value.value?.ticket;
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        backgroundColor: c.bg,
        appBar: AppBar(
          title: Text(t == null ? 'Ticket' : 'Ticket #${t.summary.number}'),
          backgroundColor: c.bg,
          actions: [
            if (t != null && !t.summary.status.isFinal) _ActionsMenu(ticketId: ticketId, ticket: t),
          ],
          bottom: TabBar(
            labelColor: c.ink,
            unselectedLabelColor: c.muted,
            indicatorColor: c.accent,
            tabs: const [Tab(text: 'Messages'), Tab(text: 'History')],
          ),
        ),
        body: Polling(
          interval: ticketRefresh,
          onTick: () => ref.read(ticketThreadProvider(ticketId).notifier).refresh(),
          child: AsyncView(
            value: value,
            onRetry: () => ref.invalidate(ticketThreadProvider(ticketId)),
            builder: (thread) => TabBarView(
              children: [
                _Thread(ticketId: ticketId, thread: thread),
                _History(events: thread.events),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// What a ticket refusal means, in words.
String ticketRefusalText(Refused<Object?> r) => switch (r.code) {
      'invalid_transition' => "That status change isn't allowed from where the ticket is now.",
      'reason_required' || 'resolution_required' => 'Say what was done (at least 3 characters).',
      'assignee_ineligible' => "That person can't take tickets in this zone.",
      'max_level' => 'This ticket is already at the top escalation level.',
      'bad_file' => 'Attach JPEG, PNG, WebP or PDF files of 5 MB or less.',
      'bad_request' => 'Check the message and try again.',
      'permission_denied' || 'forbidden' => "You don't have permission for that. Ask an admin.",
      'not_found' => "This ticket isn't in your zones.",
      'rate_limited' => 'Too many changes at once. Wait a moment.',
      _ => "That didn't go through (${r.code}).",
    };

/// Sends one ticket write; on a network fault offers Retry with the same
/// write (same `clientActionId`), never a second one.
Future<void> runTicketWrite<T>(
  BuildContext context,
  WidgetRef ref,
  Future<Outcome<T>> Function() call, {
  required String Function(Applied<T>) done,
}) async {
  final Outcome<T> out;
  try {
    out = await call();
  } on ApiException catch (e) {
    if (e.unauthorized) {
      await handleUnauthorized(ref, e);
      return;
    }
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text("That didn't go through. ${e.friendly}"),
        duration: const Duration(seconds: 8),
        action: SnackBarAction(label: 'Retry', onPressed: () => runTicketWrite<T>(context, ref, call, done: done)),
      ));
    return;
  }
  if (!context.mounted) return;
  showSnack(context, switch (out) {
    Applied<T>() => done(out),
    Refused<T>() => ticketRefusalText(out),
  });
}

enum _Act { status, reopen, assign, priority, escalate }

class _ActionsMenu extends ConsumerWidget {
  const _ActionsMenu({required this.ticketId, required this.ticket});
  final String ticketId;
  final TicketDetail ticket;

  static const _fallback = [
    TicketStatus.inProgress,
    TicketStatus.waitingOnRequester,
    TicketStatus.resolved,
    TicketStatus.closed,
  ];

  static String _verb(TicketStatus s) => switch (s) {
        TicketStatus.inProgress => 'Mark In Progress',
        TicketStatus.waitingOnRequester => 'Waiting on requester',
        TicketStatus.resolved => 'Resolve',
        TicketStatus.closed => 'Close',
        _ => s.displayLabel,
      };

  TicketThreadNotifier _n(WidgetRef ref) => ref.read(ticketThreadProvider(ticketId).notifier);

  Future<void> _status(BuildContext context, WidgetRef ref, TicketStatus to) async {
    String? resolution;
    if (to == TicketStatus.resolved || (to == TicketStatus.closed && ticket.resolution == null)) {
      resolution = await showReasonDialog(
        context,
        title: to == TicketStatus.resolved ? 'Resolve this ticket' : 'Close this ticket',
        hint: 'What was done about it',
        submitLabel: to == TicketStatus.resolved ? 'Resolve' : 'Close',
        maxLength: 1000,
        quickPicks: const ['Refund issued', 'Replacement sent', 'Explained to the requester', 'Duplicate ticket'],
        message: to == TicketStatus.closed ? 'A closed ticket cannot be reopened.' : null,
      );
      if (resolution == null) return;
    }
    if (!context.mounted) return;
    final s = TicketStatusChange(status: to, resolution: resolution);
    await runTicketWrite<void>(context, ref, () => _n(ref).setStatus(s),
        done: (_) => 'Ticket is now ${to.displayLabel.toLowerCase()}.');
  }

  Future<void> _reopen(BuildContext context, WidgetRef ref) async {
    final reason = await showReasonDialog(
      context,
      title: 'Reopen this ticket',
      hint: 'Why it needs more work',
      submitLabel: 'Reopen',
      quickPicks: const ['Requester says it is not fixed', 'It happened again', 'Resolved by mistake'],
    );
    if (reason == null || !context.mounted) return;
    final s = TicketStatusChange(status: TicketStatus.inProgress, reason: reason);
    await runTicketWrite<void>(context, ref, () => _n(ref).setStatus(s), done: (_) => 'Ticket reopened.');
  }

  Future<void> _assign(BuildContext context, WidgetRef ref) async {
    final a = await showAssignSheet(context, ticket: ticket);
    if (a == null || !context.mounted) return;
    await runTicketWrite<void>(context, ref, () => _n(ref).assign(a),
        done: (_) => a.assigneeId == null && a.team == null ? 'Ticket unassigned.' : 'Ticket assigned.');
  }

  Future<void> _priority(BuildContext context, WidgetRef ref) async {
    final current = ticket.summary.priority;
    final next = await showDialog<TicketPriority>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('Change priority'),
        children: [
          for (final p in TicketPriority.values)
            if (p != current)
              SimpleDialogOption(
                key: Key('priority-${p.name}'),
                onPressed: () => Navigator.pop(ctx, p),
                child: Text(priorityLabel(p)),
              ),
        ],
      ),
    );
    if (next == null || !context.mounted) return;
    final reason = await showReasonDialog(
      context,
      title: 'Why ${priorityLabel(next).toLowerCase()}?',
      submitLabel: 'Change priority',
      message: next == TicketPriority.emergency ? 'Emergency tickets alert every manager in the zone.' : null,
    );
    if (reason == null || !context.mounted) return;
    final p = TicketPriorityChange(priority: next, reason: reason);
    await runTicketWrite<void>(context, ref, () => _n(ref).priority(p),
        done: (_) => 'Priority is now ${priorityLabel(next).toLowerCase()}.');
  }

  Future<void> _escalate(BuildContext context, WidgetRef ref) async {
    final reason = await showReasonDialog(
      context,
      title: 'Escalate this ticket',
      hint: "Why it can't wait",
      submitLabel: 'Escalate',
      message: ticket.escalationLevel >= 1
          ? 'Level 2 and above also alert every admin.'
          : 'Managers who handle support in this zone are alerted.',
      quickPicks: const ['No response from the vendor', 'Customer threatening to leave', 'Safety concern'],
    );
    if (reason == null || !context.mounted) return;
    final e = TicketEscalate(reason: reason);
    await runTicketWrite<int>(context, ref, () => _n(ref).escalate(e),
        done: (a) => a.value == null ? 'Ticket escalated.' : 'Escalated to level ${a.value}.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = ticket.summary.status;
    final allowed = (ticket.allowedTransitions ?? _fallback.where((s) => s != current).toList())
        .where((s) => s != TicketStatus.escalated && s != current)
        .toList();
    final reopenable = current == TicketStatus.resolved && allowed.contains(TicketStatus.inProgress);
    final topLevel = ticket.escalationLevel >= TicketDetail.maxEscalationLevel;
    return PopupMenuButton<(_Act, TicketStatus?)>(
      key: const Key('ticket-status-menu'),
      tooltip: 'Ticket actions',
      icon: const Icon(Icons.more_vert),
      onSelected: (v) => switch (v.$1) {
        _Act.status => _status(context, ref, v.$2!),
        _Act.reopen => _reopen(context, ref),
        _Act.assign => _assign(context, ref),
        _Act.priority => _priority(context, ref),
        _Act.escalate => _escalate(context, ref),
      },
      itemBuilder: (_) => [
        for (final s in allowed)
          if (!(reopenable && s == TicketStatus.inProgress))
            PopupMenuItem(key: Key('ticket-action-${s.wire}'), value: (_Act.status, s), child: Text(_verb(s))),
        if (reopenable)
          const PopupMenuItem(key: Key('ticket-action-reopen'), value: (_Act.reopen, null), child: Text('Reopen…')),
        const PopupMenuDivider(),
        const PopupMenuItem(key: Key('ticket-action-assign'), value: (_Act.assign, null), child: Text('Assign…')),
        const PopupMenuItem(
            key: Key('ticket-action-priority'), value: (_Act.priority, null), child: Text('Change priority…')),
        if (topLevel)
          const PopupMenuItem(enabled: false, value: (_Act.escalate, null), child: Text('Escalated to the top level'))
        else
          const PopupMenuItem(key: Key('ticket-action-escalate'), value: (_Act.escalate, null), child: Text('Escalate…')),
      ],
    );
  }
}

/// Attachments per reply, and the largest file the server takes (5 MB).
const ticketAttachmentMaxBytes = 5 * 1024 * 1024;

class _Thread extends ConsumerStatefulWidget {
  const _Thread({required this.ticketId, required this.thread});
  final String ticketId;
  final TicketThread thread;

  @override
  ConsumerState<_Thread> createState() => _ThreadState();
}

class _ThreadState extends ConsumerState<_Thread> {
  final _text = TextEditingController();
  bool _internal = false;
  bool _sending = false;
  final List<XFile> _files = [];

  /// The reply that failed to reach the server, resent as-is (same id) on
  /// Retry — never a second message.
  TicketReply? _pending;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _attach() async {
    if (_files.length >= TicketReply.maxFiles) {
      showSnack(context, 'Up to ${TicketReply.maxFiles} attachments');
      return;
    }
    final f = await ref.read(documentPickerProvider)(context);
    if (f == null || !mounted) return;
    final ext = f.name.split('.').last.toLowerCase();
    if (!documentExtensions.contains(ext)) {
      showSnack(context, 'Use a JPEG, PNG, WebP or PDF file.');
      return;
    }
    if (await f.length() > ticketAttachmentMaxBytes) {
      if (mounted) showSnack(context, 'That file is over 5 MB.');
      return;
    }
    if (mounted) setState(() => _files.add(f));
  }

  Future<void> _send([TicketReply? retry]) async {
    final body = _text.text.trim();
    final reply = retry ?? TicketReply(body: body, internal: _internal, files: List.of(_files));
    if (reply.body.isEmpty || _sending) return;
    setState(() {
      _sending = true;
      _pending = reply;
    });
    final Outcome<void> out;
    try {
      out = await ref.read(ticketThreadProvider(widget.ticketId).notifier).reply(reply);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _sending = false);
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text("Your ${reply.internal ? 'note' : 'reply'} wasn't sent. ${e.friendly}"),
          duration: const Duration(seconds: 8),
          action: SnackBarAction(label: 'Retry', onPressed: () => _send(reply)),
        ));
      return;
    }
    if (!mounted) return;
    setState(() => _sending = false);
    switch (out) {
      case Applied():
        _pending = null;
        _text.clear();
        setState(() {
          _files.clear();
          if (reply.internal) _internal = false;
        });
      case Refused():
        _pending = null;
        showSnack(context, ticketRefusalText(out));
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final t = widget.thread.ticket;
    final s = t.summary;
    final when = DateFormat('d MMM, h:mm a');
    final open = ref.read(urlOpenerProvider);
    final small = TextStyle(color: c.muted, fontSize: 12.5);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            children: [
              Text(s.subject, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: c.ink)),
              const SizedBox(height: 6),
              Wrap(
                spacing: 12,
                runSpacing: 4,
                children: [
                  StatusText(s.status.displayLabel, color: ticketStatusColor(c, s.status)),
                  Text(categoryLabel(s.category), style: small),
                  Text(priorityLabel(s.priority),
                      style: TextStyle(color: s.priority == TicketPriority.normal ? c.muted : c.deal, fontSize: 12.5)),
                  Text(
                    t.requester == null
                        ? 'From ${s.requesterRole.label.toLowerCase()}'
                        : 'From ${t.requester!.name} (${s.requesterRole.label.toLowerCase()})',
                    style: small,
                  ),
                  if (t.escalationLevel > 0)
                    Text('Escalated · level ${t.escalationLevel}', style: TextStyle(color: c.deal, fontSize: 12.5)),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                [
                  t.assignee == null ? 'Unassigned' : 'Assigned to ${t.assignee!.name}',
                  ?t.team?.label,
                ].join(' · '),
                key: const Key('ticket-assignment'),
                style: TextStyle(color: c.ink, fontSize: 13, fontWeight: FontWeight.w600),
              ),
              if (t.restaurant != null || s.orderId != null) ...[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  children: [
                    if (t.restaurant != null)
                      ActionChip(
                        avatar: const Icon(Icons.storefront_outlined, size: 16),
                        label: Text(t.restaurant!.name),
                        onPressed: () => context.push('/more/vendors/${t.restaurant!.id}'),
                      ),
                    if (s.orderId != null)
                      ActionChip(
                        avatar: const Icon(Icons.receipt_long_outlined, size: 16),
                        label: const Text('The order'),
                        onPressed: () => context.push('/orders/${s.orderId}'),
                      ),
                  ],
                ),
              ],
              if (t.resolution != null) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(color: c.greenSoft, borderRadius: BorderRadius.circular(10)),
                  child: Text('Resolution: ${t.resolution}', style: TextStyle(color: c.ink)),
                ),
              ],
              const SizedBox(height: 12),
              for (final m in widget.thread.messages)
                _Message(
                  message: m,
                  when: m.at == null ? '' : when.format(m.at!.toLocal()),
                  onOpen: (url) => open(Uri.parse(url)),
                ),
            ],
          ),
        ),
        if (s.status.isFinal)
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Text('This ticket is closed.', textAlign: TextAlign.center, style: TextStyle(color: c.muted)),
            ),
          )
        else
          _composer(c),
      ],
    );
  }

  Widget _composer(AppColors c) => SafeArea(
        top: false,
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
          decoration: BoxDecoration(color: c.surface, border: Border(top: BorderSide(color: c.line))),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  FilterChip(
                    key: const Key('ticket-internal-toggle'),
                    avatar: Icon(_internal ? Icons.lock_outline : Icons.reply_outlined, size: 16),
                    label: Text(_internal ? 'Internal note' : 'Reply'),
                    selected: _internal,
                    onSelected: _sending ? null : (v) => setState(() => _internal = v),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _internal ? 'Only Deligro staff see this.' : 'The requester is notified.',
                      style: TextStyle(color: c.muted, fontSize: 12),
                    ),
                  ),
                ],
              ),
              if (_files.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: [
                      for (final f in _files)
                        InputChip(
                          avatar: const Icon(Icons.attach_file, size: 16),
                          label: Text(f.name),
                          onDeleted: _sending ? null : () => setState(() => _files.remove(f)),
                          deleteButtonTooltipMessage: 'Remove',
                        ),
                    ],
                  ),
                ),
              const SizedBox(height: 6),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  IconButton(
                    key: const Key('ticket-attach'),
                    tooltip: 'Attach a photo or PDF',
                    onPressed: _sending ? null : _attach,
                    icon: const Icon(Icons.attach_file),
                  ),
                  Expanded(
                    child: TextField(
                      key: const Key('ticket-composer'),
                      controller: _text,
                      minLines: 1,
                      maxLines: 5,
                      maxLength: 4000,
                      textCapitalization: TextCapitalization.sentences,
                      onChanged: (_) => setState(() {}),
                      decoration: InputDecoration(
                        hintText: _internal ? 'Write an internal note' : 'Write a reply',
                        counterText: '',
                        border: const OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  IconButton.filled(
                    key: const Key('ticket-send'),
                    tooltip: 'Send',
                    onPressed: _sending || (_text.text.trim().isEmpty && _pending == null) ? null : () => _send(),
                    icon: _sending
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.send_rounded),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
}

class _Message extends StatelessWidget {
  const _Message({required this.message, required this.when, required this.onOpen});
  final TicketMessage message;
  final String when;
  final void Function(String url) onOpen;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final m = message;
    final staff = m.author.isStaff;
    final bg = m.internal ? c.dealSoft : (staff ? c.accentSoft : c.surface);
    return Align(
      alignment: staff ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(radiusBlock),
            border: Border.all(color: m.internal ? c.deal.withValues(alpha: 0.35) : c.line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (m.internal)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.lock_outline, size: 13, color: c.deal),
                      const SizedBox(width: 4),
                      Flexible(
                        child: Text('Internal — not visible to requester',
                            style: TextStyle(color: c.deal, fontSize: 12, fontWeight: FontWeight.w700)),
                      ),
                    ],
                  ),
                ),
              Text(m.body, style: TextStyle(color: c.ink, height: 1.35)),
              for (final a in m.attachments)
                TextButton.icon(
                  onPressed: () => onOpen(a.url),
                  icon: const Icon(Icons.attach_file, size: 16),
                  label: Text(a.name),
                ),
              const SizedBox(height: 4),
              Text('${m.author.name} · $when', style: TextStyle(color: c.muted, fontSize: 11.5)),
            ],
          ),
        ),
      ),
    );
  }
}

/// The ticket's history, oldest first.
class _History extends StatelessWidget {
  const _History({required this.events});
  final List<TicketEvent> events;

  static String _status(String? wire) => wire == null ? '—' : TicketStatus.parse(wire).displayLabel;
  static String _priority(String? wire) => wire == null ? '—' : priorityLabel(TicketPriority.parse(wire));
  static String _team(String? wire) => TicketTeam.parse(wire)?.label ?? wire ?? 'none';

  static String line(TicketEvent e) {
    final by = e.actor == null ? '' : ' by ${e.actor!.name}';
    return switch (e.kind) {
      TicketEventKind.created => 'Ticket raised',
      TicketEventKind.status => 'Status: ${_status(e.from)} → ${_status(e.to)}',
      TicketEventKind.assigned => e.to == null ? 'Unassigned$by' : 'Assigned to ${e.to}$by',
      TicketEventKind.team => 'Team: ${_team(e.to)}',
      TicketEventKind.priority => 'Priority: ${_priority(e.from)} → ${_priority(e.to)}',
      TicketEventKind.escalated => 'Escalated to level ${e.to ?? '?'}',
      TicketEventKind.reopened => 'Reopened',
      TicketEventKind.firstResponse => 'First response',
      TicketEventKind.attachment => 'Attachment added',
      TicketEventKind.unknown => 'Updated',
    };
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    if (events.isEmpty) return const Padding(padding: EdgeInsets.all(16), child: EmptyLine('No history yet.'));
    final when = DateFormat('d MMM, h:mm a');
    return ListView.separated(
      key: const Key('ticket-history'),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
      itemCount: events.length,
      separatorBuilder: (_, _) => Divider(height: 16, color: c.line),
      itemBuilder: (_, i) {
        final e = events[i];
        final meta = [
          if (e.kind != TicketEventKind.assigned && e.actor != null) e.actor!.name,
          if (e.at != null) when.format(e.at!.toLocal()),
        ].join(' · ');
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(e.internal ? Icons.lock_outline : Icons.history, size: 18, color: e.internal ? c.deal : c.muted),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(line(e), style: TextStyle(color: c.ink, fontWeight: FontWeight.w600)),
                  if (e.reason != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text('"${e.reason}"', style: TextStyle(color: c.ink, fontSize: 13)),
                    ),
                  if (meta.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(meta, style: TextStyle(color: c.muted, fontSize: 12)),
                    ),
                ],
              ),
            ),
          ],
        );
      },
    );
  }
}
