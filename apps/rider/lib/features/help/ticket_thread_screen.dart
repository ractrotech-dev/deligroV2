import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/support.dart';
import '../../state/support.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'attachments.dart';
import 'help_screen.dart' show TicketStatusChip, helpPath;
import 'signed_photo.dart';
import 'support_errors.dart';

/// One ticket: what the rider wrote, what Deligro answered, and a reply box.
/// The server sends only what the rider may read (never internal notes).
class TicketThreadScreen extends ConsumerStatefulWidget {
  const TicketThreadScreen({super.key, required this.id});

  final String id;

  @override
  ConsumerState<TicketThreadScreen> createState() => _TicketThreadScreenState();
}

class _TicketThreadScreenState extends ConsumerState<TicketThreadScreen> {
  final _reply = TextEditingController();
  List<File> _photos = [];
  bool _sending = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reply.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  bool get _ready => _reply.text.trim().isNotEmpty && !_sending;

  Future<void> _send() async {
    if (!_ready) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      await ref.read(supportRepoProvider).reply(widget.id, _reply.text.trim(), photos: _photos);
      ref.invalidate(ticketThreadProvider(widget.id));
      ref.invalidate(supportOverviewProvider);
      if (!mounted) return;
      setState(() {
        _sending = false;
        _reply.clear();
        _photos = [];
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _sending = false;
        _error = supportErrorText(e);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final thread = ref.watch(ticketThreadProvider(widget.id));
    final c = context.colors;
    final t = thread.value?.ticket;
    return Scaffold(
      appBar: AppBar(
        title: Text(t == null ? 'Ticket' : 'Ticket #${t.number}'),
        leading: BackButton(onPressed: () => context.canPop() ? context.pop() : context.go(helpPath)),
      ),
      body: SafeArea(
        bottom: false,
        child: thread.when(
          skipLoadingOnRefresh: true,
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => e is ApiException && e.status == 404
              ? const EmptyState(
                  icon: Icons.search_off_rounded,
                  title: "We couldn't find that ticket",
                  body: 'It may belong to another account.',
                )
              : ErrorRetry(error: e, onRetry: () => ref.invalidate(ticketThreadProvider(widget.id))),
          data: (data) => Column(
            children: [
              Expanded(
                child: RefreshIndicator(
                  onRefresh: () async {
                    ref.invalidate(ticketThreadProvider(widget.id));
                    await ref
                        .read(ticketThreadProvider(widget.id).future)
                        .then<void>((_) {}, onError: (_) {});
                  },
                  child: ListView(
                    key: const Key('thread-list'),
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                    children: [
                      _TicketHeader(ticket: data.ticket),
                      const SizedBox(height: 14),
                      for (final m in data.messages) ...[
                        _Bubble(message: m),
                        const SizedBox(height: 10),
                      ],
                    ],
                  ),
                ),
              ),
              Material(
                color: c.surface,
                child: Container(
                  decoration: BoxDecoration(border: Border(top: BorderSide(color: c.line))),
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                  child: SafeArea(
                    top: false,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (data.ticket.isClosed)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 6, left: 4),
                            child: Text(
                              'This ticket is ${data.ticket.statusLabel.toLowerCase()}. Replying opens it again.',
                              key: const Key('reopen-note'),
                              style: TextStyle(color: c.muted, fontSize: 13),
                            ),
                          ),
                        if (_photos.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: PhotoAttachments(photos: _photos, onChanged: (p) => setState(() => _photos = p)),
                          ),
                        if (_error != null)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 6, left: 4),
                            child: Text(
                              _error!,
                              key: const Key('reply-error'),
                              style: TextStyle(color: c.deal, fontWeight: FontWeight.w700, fontSize: 13.5),
                            ),
                          ),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            if (_photos.isEmpty)
                              PhotoAttachments(
                                compact: true,
                                photos: _photos,
                                onChanged: (p) => setState(() => _photos = p),
                              ),
                            Expanded(
                              child: TextField(
                                key: const Key('reply-field'),
                                controller: _reply,
                                minLines: 1,
                                maxLines: 5,
                                maxLength: 4000,
                                buildCounter: (_, {required currentLength, required isFocused, maxLength}) => null,
                                textCapitalization: TextCapitalization.sentences,
                                decoration: const InputDecoration(hintText: 'Write a reply'),
                              ),
                            ),
                            const SizedBox(width: 8),
                            IconButton.filled(
                              key: const Key('send-reply'),
                              tooltip: 'Send reply',
                              onPressed: _ready ? _send : null,
                              icon: _sending
                                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
                                  : const Icon(Icons.send_rounded),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TicketHeader extends StatelessWidget {
  const _TicketHeader({required this.ticket});

  final TicketDetail ticket;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final t = ticket;
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(t.categoryLabel, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Align(alignment: Alignment.centerLeft, child: TicketStatusChip(ticket: t)),
          const SizedBox(height: 8),
          Text(
            [
              if (t.isEmergency) 'Emergency',
              if (t.orderCode != null) 'Order ${t.orderCode}',
              if (t.createdAt != null) 'Opened ${placedAt(t.createdAt)}',
            ].join(' · '),
            style: TextStyle(color: c.muted, fontSize: 13),
          ),
        ],
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.message});

  final TicketMessage message;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final staff = message.fromStaff;
    return Align(
      alignment: staff ? Alignment.centerLeft : Alignment.centerRight,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.84),
        child: Container(
          key: Key(staff ? 'msg-staff-${message.id}' : 'msg-rider-${message.id}'),
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
          decoration: BoxDecoration(
            color: staff ? c.surface : c.accentSoft,
            borderRadius: BorderRadius.circular(radiusBlock),
            border: Border.all(color: staff ? c.line : Colors.transparent),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                staff ? 'Deligro' : 'You',
                style: TextStyle(
                  color: staff ? c.green : c.accentInk,
                  fontWeight: FontWeight.w800,
                  fontSize: 12.5,
                ),
              ),
              const SizedBox(height: 3),
              Text(message.body, style: const TextStyle(height: 1.35, fontSize: 15.5)),
              if (message.photoUrls.isNotEmpty) ...[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final url in message.photoUrls)
                      InkWell(
                        onTap: () => _view(context, url),
                        child: SignedPhoto(url: url),
                      ),
                  ],
                ),
              ],
              if (message.createdAt != null) ...[
                const SizedBox(height: 4),
                Text(placedAt(message.createdAt), style: TextStyle(color: c.muted, fontSize: 12)),
              ],
            ],
          ),
        ),
      ),
    );
  }

  void _view(BuildContext context, String url) {
    showDialog<void>(
      context: context,
      builder: (dialog) => Dialog(
        child: InteractiveViewer(
          child: Image.network(
            url,
            errorBuilder: (_, _, _) => const Padding(
              padding: EdgeInsets.all(32),
              child: Text("This photo can't be shown any more."),
            ),
          ),
        ),
      ),
    );
  }
}
