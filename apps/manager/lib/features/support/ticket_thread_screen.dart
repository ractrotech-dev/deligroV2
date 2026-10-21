import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../models/outcome.dart';
import '../../models/tickets.dart';
import '../../state/session.dart';
import '../../state/tickets.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/contact_buttons.dart';
import '../../widgets/polling.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/reason_dialog.dart';
import 'ticket_labels.dart';

/// One support ticket (§4.15, §11): what was raised, every reply and
/// internal note in order, and the status — resolving or closing asks what
/// was done about it. Re-asks every 10 s while open.
class TicketThreadScreen extends ConsumerWidget {
  const TicketThreadScreen({super.key, required this.ticketId});
  final String ticketId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final value = ref.watch(ticketThreadProvider(ticketId));
    final t = value.value?.ticket;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Text(t == null ? 'Ticket' : 'Ticket #${t.summary.number}'),
        backgroundColor: c.bg,
        actions: [
          if (t != null && !t.summary.status.isFinal) _StatusMenu(ticketId: ticketId, current: t.summary.status),
        ],
      ),
      body: Polling(
        interval: ticketRefresh,
        onTick: () => ref.read(ticketThreadProvider(ticketId).notifier).refresh(),
        child: AsyncView(
          value: value,
          onRetry: () => ref.invalidate(ticketThreadProvider(ticketId)),
          builder: (thread) => _Thread(ticketId: ticketId, thread: thread),
        ),
      ),
    );
  }
}

/// What a ticket refusal means, in words.
String ticketRefusalText(Refused<Object?> r) => switch (r.code) {
      'invalid_transition' => "That status change isn't allowed from where the ticket is now.",
      'reason_required' || 'resolution_required' => 'Say what was done (at least 3 characters).',
      'bad_request' => 'Check the message and try again.',
      'permission_denied' || 'forbidden' => "You don't have permission for that. Ask an admin.",
      'not_found' => "This ticket isn't in your zones.",
      'rate_limited' => 'Too many messages at once. Wait a moment.',
      _ => "That didn't go through (${r.code}).",
    };

class _StatusMenu extends ConsumerWidget {
  const _StatusMenu({required this.ticketId, required this.current});
  final String ticketId;
  final TicketStatus current;

  static const _choices = [
    TicketStatus.inProgress,
    TicketStatus.waitingOnRequester,
    TicketStatus.resolved,
    TicketStatus.closed,
  ];

  Future<void> _change(BuildContext context, WidgetRef ref, TicketStatus to) async {
    String? resolution;
    if (to == TicketStatus.resolved || to == TicketStatus.closed) {
      resolution = await showReasonDialog(
        context,
        title: to == TicketStatus.resolved ? 'Resolve this ticket' : 'Close this ticket',
        hint: 'What was done about it',
        submitLabel: to.label,
        maxLength: 1000,
        quickPicks: const ['Refund issued', 'Replacement sent', 'Explained to the requester', 'Duplicate ticket'],
        message: to == TicketStatus.closed ? 'A closed ticket cannot be reopened.' : null,
      );
      if (resolution == null) return;
    }
    if (!context.mounted) return;
    await _send(context, ref, TicketStatusChange(status: to, resolution: resolution));
  }

  Future<void> _send(BuildContext context, WidgetRef ref, TicketStatusChange s) async {
    final Outcome<void> out;
    try {
      out = await ref.read(ticketThreadProvider(ticketId).notifier).setStatus(s);
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!context.mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text(e.friendly),
          action: SnackBarAction(label: 'Retry', onPressed: () => _send(context, ref, s)),
        ));
      return;
    }
    if (!context.mounted) return;
    showSnack(context, out is Refused ? ticketRefusalText(out) : 'Ticket is now ${s.status.label.toLowerCase()}.');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) => PopupMenuButton<TicketStatus>(
        key: const Key('ticket-status-menu'),
        tooltip: 'Change status',
        icon: const Icon(Icons.more_vert),
        onSelected: (to) => _change(context, ref, to),
        itemBuilder: (_) => [
          for (final s in _choices)
            if (s != current) PopupMenuItem(value: s, child: Text(s.label)),
        ],
      );
}

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

  /// The reply that failed to reach the server, resent as-is (same id) on
  /// Retry — never a second message.
  TicketReply? _pending;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _send([TicketReply? retry]) async {
    final body = _text.text.trim();
    final reply = retry ?? TicketReply(body: body, internal: _internal);
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
        if (reply.internal) setState(() => _internal = false);
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
                  StatusText(s.status.label, color: ticketStatusColor(c, s.status)),
                  Text(categoryLabel(s.category), style: TextStyle(color: c.muted, fontSize: 12.5)),
                  Text(priorityLabel(s.priority),
                      style: TextStyle(color: s.priority.name == 'normal' ? c.muted : c.deal, fontSize: 12.5)),
                  Text('From ${s.requesterRole.label.toLowerCase()}', style: TextStyle(color: c.muted, fontSize: 12.5)),
                  if (t.escalationLevel > 0)
                    Text('Escalated · level ${t.escalationLevel}', style: TextStyle(color: c.deal, fontSize: 12.5)),
                ],
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
              const SizedBox(height: 6),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
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
                      Text('Internal note', style: TextStyle(color: c.deal, fontSize: 12, fontWeight: FontWeight.w700)),
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
