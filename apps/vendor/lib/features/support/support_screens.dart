import 'dart:typed_data';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/growth.dart';
import '../../state/growth.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

/// Help & support (requirements §12): raise a ticket (with photos, linked to an
/// order if it's about one), follow the conversation, or call Deligro.
class SupportScreen extends ConsumerWidget {
  const SupportScreen({super.key});

  /// Deligro's support line, from the build (`--dart-define=SUPPORT_PHONE=…`).
  static const supportPhone = String.fromEnvironment('SUPPORT_PHONE');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final async = ref.watch(ticketsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Help & support')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/more/support/new'),
        icon: const Icon(Icons.add_comment_outlined),
        label: const Text('New ticket'),
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(ticketsProvider.future),
        child: ListView(
          padding: const EdgeInsets.only(top: 8, bottom: 96),
          children: [
            if (supportPhone.isNotEmpty)
              Panel(
                padding: EdgeInsets.zero,
                child: ListTile(
                  leading: Icon(Icons.call_rounded, color: c.green),
                  title: const Text('Call Deligro support', style: TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: const Text('For anything urgent with a live order'),
                  onTap: () => launchUrl(Uri(scheme: 'tel', path: supportPhone)),
                ),
              ),
            const SectionHeading('Your tickets'),
            switch (async) {
              AsyncData(:final value) when value.isEmpty => Padding(
                padding: const EdgeInsets.all(32),
                child: Text(
                  'No tickets yet. Raise one and Deligro replies here.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: c.muted),
                ),
              ),
              AsyncData(:final value) => Column(children: [for (final t in value) _TicketTile(t: t)]),
              AsyncError(:final error) => SizedBox(
                height: 280,
                child: LoadFailed(error: error, onRetry: () => ref.invalidate(ticketsProvider)),
              ),
              _ => const Padding(
                padding: EdgeInsets.all(40),
                child: Center(child: CircularProgressIndicator()),
              ),
            },
          ],
        ),
      ),
    );
  }
}

(Color, String) ticketStatusLook(BuildContext context, String status) {
  final c = context.colors;
  return switch (status) {
    'open' => (c.deal, 'Open'),
    'in_progress' => (c.blue, 'Being looked at'),
    'waiting_on_requester' => (c.accentInk, 'Waiting for you'),
    'resolved' => (c.green, 'Resolved'),
    _ => (c.muted, 'Closed'),
  };
}

class _TicketTile extends StatelessWidget {
  const _TicketTile({required this.t});
  final Ticket t;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (fg, word) = ticketStatusLook(context, t.status);
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 2),
      onTap: () => context.push('/more/support/${t.id}'),
      title: Text(
        t.subject,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontWeight: FontWeight.w700),
      ),
      subtitle: Text(
        '#${t.number} · ${ticketCategories[t.category] ?? t.category} · ${placedAt(t.updatedAt)}',
        style: TextStyle(color: c.muted, fontSize: 12.5),
      ),
      trailing: Text(
        word,
        style: TextStyle(color: fg, fontWeight: FontWeight.w700, fontSize: 12.5),
      ),
    );
  }
}

/// Photo picker shared by a new ticket and a reply: up to four JPEGs.
class _Photos extends StatelessWidget {
  const _Photos({required this.photos, required this.onAdd, required this.onRemove});
  final List<Uint8List> photos;
  final VoidCallback onAdd;
  final void Function(int) onRemove;

  @override
  Widget build(BuildContext context) => Wrap(
    spacing: 8,
    runSpacing: 8,
    children: [
      for (final (i, p) in photos.indexed)
        Stack(
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: Image.memory(p, width: 72, height: 72, fit: BoxFit.cover),
            ),
            Positioned(
              right: 0,
              top: 0,
              child: InkWell(
                onTap: () => onRemove(i),
                child: const CircleAvatar(
                  radius: 11,
                  backgroundColor: Colors.black54,
                  child: Icon(Icons.close_rounded, size: 14, color: Colors.white),
                ),
              ),
            ),
          ],
        ),
      if (photos.length < 4)
        OutlinedButton.icon(
          onPressed: onAdd,
          icon: const Icon(Icons.add_a_photo_outlined, size: 18),
          label: const Text('Photo'),
        ),
    ],
  );
}

Future<Uint8List?> _pickPhoto() async {
  final f = await ImagePicker().pickImage(source: ImageSource.gallery, maxWidth: 1600, imageQuality: 75);
  return f?.readAsBytes();
}

class NewTicketScreen extends ConsumerStatefulWidget {
  const NewTicketScreen({super.key, this.orderId, this.orderCode});

  final String? orderId;
  final String? orderCode;

  @override
  ConsumerState<NewTicketScreen> createState() => _NewTicketScreenState();
}

class _NewTicketScreenState extends ConsumerState<NewTicketScreen> {
  final _form = GlobalKey<FormState>();
  late String _category = widget.orderId != null ? 'orders' : 'payments';
  final _subject = TextEditingController();
  final _body = TextEditingController();
  final _photos = <Uint8List>[];
  bool _sending = false;

  @override
  void dispose() {
    _subject.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (!_form.currentState!.validate()) return;
    setState(() => _sending = true);
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    try {
      final repo = ref.read(growthRepoProvider);
      final paths = [for (final p in _photos) await repo.uploadPhoto(p)];
      final id = await repo.openTicket({
        'category': _category,
        'subject': _subject.text.trim(),
        'body': _body.text.trim(),
        'orderId': widget.orderId,
        'attachments': paths,
      });
      ref.invalidate(ticketsProvider);
      messenger.showSnackBar(const SnackBar(content: Text('Ticket sent. Deligro will reply here.')));
      router.pushReplacement('/more/support/$id');
    } on ApiException catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.friendly())));
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text('Something went wrong. Try again.')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('New ticket')),
    bottomNavigationBar: SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
        child: FilledButton(onPressed: _sending ? null : _send, child: Text(_sending ? 'Sending…' : 'Send to Deligro')),
      ),
    ),
    body: Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
        children: [
          if (widget.orderCode != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Panel(
                child: Text('About order ${widget.orderCode}', style: const TextStyle(fontWeight: FontWeight.w700)),
              ),
            ),
          const Text('What is it about?', style: TextStyle(fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final e in ticketCategories.entries)
                ChoiceChip(
                  label: Text(e.value),
                  selected: _category == e.key,
                  onSelected: (_) => setState(() => _category = e.key),
                ),
            ],
          ),
          const SizedBox(height: 16),
          TextFormField(
            controller: _subject,
            maxLength: 120,
            decoration: const InputDecoration(labelText: 'Subject'),
            validator: (v) => (v ?? '').trim().length < 3 ? 'At least 3 characters' : null,
          ),
          TextFormField(
            controller: _body,
            maxLength: 4000,
            minLines: 4,
            maxLines: 10,
            decoration: const InputDecoration(labelText: 'Tell us what happened'),
            validator: (v) => (v ?? '').trim().isEmpty ? 'Required' : null,
          ),
          const SizedBox(height: 8),
          _Photos(
            photos: _photos,
            onAdd: () async {
              final p = await _pickPhoto();
              if (p != null) setState(() => _photos.add(p));
            },
            onRemove: (i) => setState(() => _photos.removeAt(i)),
          ),
        ],
      ),
    ),
  );
}

class TicketScreen extends ConsumerStatefulWidget {
  const TicketScreen({super.key, required this.id});
  final String id;

  @override
  ConsumerState<TicketScreen> createState() => _TicketScreenState();
}

class _TicketScreenState extends ConsumerState<TicketScreen> {
  final _reply = TextEditingController();
  final _photos = <Uint8List>[];
  bool _sending = false;

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    if (_reply.text.trim().isEmpty) return;
    setState(() => _sending = true);
    final ok = await runWrite(context, ref, () async {
      final repo = ref.read(growthRepoProvider);
      final paths = [for (final p in _photos) await repo.uploadPhoto(p)];
      await repo.replyTicket(widget.id, _reply.text.trim(), paths);
    });
    if (!mounted) return;
    setState(() => _sending = false);
    if (ok) {
      _reply.clear();
      _photos.clear();
      ref.invalidate(ticketProvider(widget.id));
      ref.invalidate(ticketsProvider);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final async = ref.watch(ticketProvider(widget.id));
    final t = async.value?.ticket;
    return Scaffold(
      appBar: AppBar(title: Text(t == null ? 'Ticket' : '#${t.number}')),
      body: switch (async) {
        AsyncData(:final value) => Column(
          children: [
            Expanded(
              child: RefreshIndicator(
                onRefresh: () => ref.refresh(ticketProvider(widget.id).future),
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                  children: [
                    Text(value.ticket.subject, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                    Text(
                      '${ticketCategories[value.ticket.category] ?? value.ticket.category} · ${ticketStatusLook(context, value.ticket.status).$2}',
                      style: TextStyle(color: c.muted),
                    ),
                    const SizedBox(height: 12),
                    for (final m in value.messages) _Bubble(m: m),
                  ],
                ),
              ),
            ),
            SafeArea(
              top: false,
              child: Container(
                padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
                decoration: BoxDecoration(
                  color: c.surface,
                  border: Border(top: BorderSide(color: c.line)),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (_photos.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: _Photos(
                          photos: _photos,
                          onAdd: () {},
                          onRemove: (i) => setState(() => _photos.removeAt(i)),
                        ),
                      ),
                    Row(
                      children: [
                        IconButton(
                          tooltip: 'Add photo',
                          onPressed: _photos.length >= 4
                              ? null
                              : () async {
                                  final p = await _pickPhoto();
                                  if (p != null) setState(() => _photos.add(p));
                                },
                          icon: const Icon(Icons.add_a_photo_outlined),
                        ),
                        Expanded(
                          child: TextField(
                            controller: _reply,
                            minLines: 1,
                            maxLines: 4,
                            maxLength: 4000,
                            decoration: const InputDecoration(hintText: 'Reply to Deligro', counterText: ''),
                          ),
                        ),
                        IconButton(
                          tooltip: 'Send',
                          onPressed: _sending ? null : _send,
                          icon: Icon(Icons.send_rounded, color: c.accent),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
        AsyncError(:final error) => LoadFailed(error: error, onRetry: () => ref.invalidate(ticketProvider(widget.id))),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.m});
  final TicketMessage m;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Align(
      alignment: m.fromYou ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.sizeOf(context).width * .8),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: m.fromYou ? c.accentSoft : c.surface,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: c.line),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              m.fromYou ? 'You' : 'Deligro support',
              style: TextStyle(color: c.muted, fontSize: 12, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 2),
            Text(m.body),
            if (m.attachments.isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final url in m.attachments)
                    ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: CachedNetworkImage(imageUrl: url, width: 90, height: 90, fit: BoxFit.cover),
                    ),
                ],
              ),
            ],
            const SizedBox(height: 4),
            Text(placedAt(m.createdAt), style: TextStyle(color: c.muted, fontSize: 11)),
          ],
        ),
      ),
    );
  }
}
