import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:latlong2/latlong.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/delivery_exception.dart';
import '../../models/outcome.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/contact_buttons.dart';
import '../../widgets/polling.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/order_mini_map.dart';
import '../orders/reason_dialog.dart';

/// The queue refreshes this often while on screen (§6: Live polls 10 s).
const exceptionsRefresh = Duration(seconds: 10);

/// Pending exceptions, oldest first, as the server orders them.
final pendingExceptionsProvider = FutureProvider.autoDispose<ExceptionPage>(
  (ref) {
    ref.watch(signedInProvider);
    return ref.read(exceptionsRepoProvider).list();
  },
  retry: (_, _) => null,
);

/// How many exceptions wait for a decision — the Live badge. Null when it
/// can't be read or this manager can't see riders.
final pendingExceptionsCountProvider = FutureProvider.autoDispose<int?>((ref) async {
  ref.watch(signedInProvider);
  final me = ref.watch(managerMeProvider).value;
  if (me == null || !me.can('manager.riders.view')) return null;
  try {
    return (await ref.read(exceptionsRepoProvider).list()).pending;
  } catch (_) {
    return null;
  }
}, retry: (_, _) => null);

/// "Needs a decision (n)" on Live, opening the queue. Hidden at zero.
class ExceptionsBadge extends ConsumerWidget {
  const ExceptionsBadge({super.key, this.onOpen});
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final n = ref.watch(pendingExceptionsCountProvider).value;
    if (n == null || n == 0) return const SizedBox.shrink();
    final c = context.colors;
    return Polling(
      interval: exceptionsRefresh,
      onTick: () => ref.invalidate(pendingExceptionsCountProvider),
      child: TextButton.icon(
        key: const Key('live-exceptions-badge'),
        style: TextButton.styleFrom(foregroundColor: c.deal),
        onPressed: onOpen ?? () => GoRouter.maybeOf(context)?.push('/live/exceptions'),
        icon: const Icon(Icons.report_problem_outlined, size: 18),
        label: Text('Needs a decision ($n)'),
      ),
    );
  }
}

/// Delivery exceptions (§6.10 manual intervention, decided here): a rider
/// asked to fail a delivery, finish without the code, go offline mid-job…
/// or reported a problem. Approve / Reject / Acknowledge as the server
/// offers; approving one that cancels the order says so first. If the
/// decision was saved but its after-effect failed, Retry re-sends the very
/// same action and the server finishes it once.
class ExceptionsScreen extends ConsumerWidget {
  const ExceptionsScreen({super.key, this.query});
  final Uri? query;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final focus = query?.queryParameters['id'];
    final value = ref.watch(pendingExceptionsProvider);
    final canDecide = ref.watch(managerMeProvider).value?.can('manager.exceptions.decide') ?? false;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Needs a decision'), backgroundColor: c.bg),
      body: Polling(
        interval: exceptionsRefresh,
        onTick: () => ref.invalidate(pendingExceptionsProvider),
        child: AsyncView(
          value: value,
          onRetry: () => ref.invalidate(pendingExceptionsProvider),
          builder: (page) => RefreshIndicator(
            onRefresh: () async => ref.invalidate(pendingExceptionsProvider),
            child: page.items.isEmpty
                ? ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    children: const [EmptyLine('Nothing needs a decision.')],
                  )
                : ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
                    children: [
                      if (!canDecide)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: Text('Deciding needs the "Delivery exceptions" permission.',
                              style: TextStyle(color: c.muted)),
                        ),
                      for (final e in page.items)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: ExceptionCard(exception: e, highlighted: e.id == focus),
                        ),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}

class ExceptionCard extends ConsumerStatefulWidget {
  const ExceptionCard({super.key, required this.exception, this.highlighted = false});
  final DeliveryException exception;
  final bool highlighted;

  @override
  ConsumerState<ExceptionCard> createState() => _ExceptionCardState();
}

class _ExceptionCardState extends ConsumerState<ExceptionCard> {
  bool _busy = false;

  /// The decision whose after-effect failed; Retry re-sends it unchanged.
  ExceptionAction? _unfinished;

  Future<void> _send(ExceptionAction a) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final out = await ref.read(exceptionsRepoProvider).decide(widget.exception.id, a);
      if (!mounted) return;
      setState(() => _unfinished = null);
      switch (out) {
        case Applied():
          showSnack(context, switch (a.decision) {
            ExceptionDecision.approve => 'Approved.',
            ExceptionDecision.reject => 'Rejected. The rider is told.',
            _ => 'Acknowledged.',
          });
        case Refused(:final code):
          showSnack(context, switch (code) {
            'already_resolved' => 'Someone else already decided this.',
            'note_required' => 'Say why — a note is needed to reject.',
            'permission_denied' || 'forbidden' => "You don't have permission for that. Ask an admin.",
            _ => "That didn't go through ($code).",
          });
      }
      ref.invalidate(pendingExceptionsProvider);
      ref.invalidate(pendingExceptionsCountProvider);
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      if (e.code == 'effect_failed') {
        setState(() => _unfinished = a);
      } else {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(
            content: Text(e.friendly),
            action: SnackBarAction(label: 'Retry', onPressed: () => _send(a)),
          ));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _decide(ExceptionDecision d) async {
    final e = widget.exception;
    switch (d) {
      case ExceptionDecision.approve:
        if (e.kind.cancelsOrder) {
          final go = await confirm(
            context,
            title: 'Approve: ${e.kind.label}?',
            message: 'This cancels order ${e.orderCode} and refunds the customer per the usual rules.',
            yes: 'Approve and cancel',
          );
          if (!go || !mounted) return;
        }
        await _send(ExceptionAction(ExceptionDecision.approve));
      case ExceptionDecision.reject:
        final note = await showReasonDialog(
          context,
          title: 'Reject this request?',
          quickPicks: const ['Customer picked up the call', 'Wait a little longer', 'Try the address again'],
          hint: 'What should the rider do instead?',
          submitLabel: 'Reject',
        );
        if (note == null || !mounted) return;
        await _send(ExceptionAction(ExceptionDecision.reject, note: note));
      case ExceptionDecision.acknowledge:
        await _send(ExceptionAction(ExceptionDecision.acknowledge));
      case ExceptionDecision.unknown:
        return;
    }
  }

  Future<void> _photo() async {
    try {
      final url = await ref.read(exceptionsRepoProvider).photoUrl(widget.exception.id);
      await ref.read(urlOpenerProvider)(Uri.parse(url));
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.friendly);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final e = widget.exception;
    final age = e.createdAt == null ? null : DateTime.now().difference(e.createdAt!).inMinutes;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: widget.highlighted ? c.accentSoft : c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: widget.highlighted ? c.accent : c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(e.kind.label, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15.5, color: c.ink)),
              ),
              if (age != null) Text(_ago(age), style: TextStyle(fontSize: 12.5, color: c.muted)),
            ],
          ),
          const SizedBox(height: 4),
          Wrap(
            spacing: 10,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              InkWell(
                key: Key('ex-order-${e.id}'),
                onTap: () => GoRouter.maybeOf(context)?.push('/orders/${e.orderId}'),
                child: Text(e.orderCode, style: dataStyle(context, size: 13.5, weight: FontWeight.w700).copyWith(color: c.accentInk)),
              ),
              Text([e.rider.name, ?e.rider.code].join(' · '), style: TextStyle(fontSize: 13, color: c.ink)),
              StatusText(e.status.label, color: e.status == ExceptionStatus.pending ? c.amberText : c.muted),
            ],
          ),
          const SizedBox(height: 6),
          Text(e.reason, style: TextStyle(fontSize: 13.5, color: c.ink)),
          if (e.notes != null) Text(e.notes!, style: TextStyle(fontSize: 13, color: c.muted)),
          if (e.lat != null && e.lng != null) ...[
            const SizedBox(height: 8),
            OrderMiniMap(rider: LatLng(e.lat!, e.lng!), height: 130),
          ],
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (e.rider.phone != null) ContactButtons(phone: e.rider.phone!, whatsapp: false),
              if (e.hasPhoto)
                TextButton.icon(
                  key: Key('ex-photo-${e.id}'),
                  onPressed: _photo,
                  icon: const Icon(Icons.photo_outlined, size: 18),
                  label: const Text('Photo'),
                ),
            ],
          ),
          if (_unfinished != null) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Text('Decision saved; finishing it failed.',
                      style: TextStyle(color: c.deal, fontWeight: FontWeight.w700)),
                ),
                TextButton(
                  key: Key('ex-retry-${e.id}'),
                  onPressed: _busy ? null : () => _send(_unfinished!),
                  child: const Text('Retry'),
                ),
              ],
            ),
          ] else if (e.decisions.isNotEmpty) ...[
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final d in e.decisions)
                  switch (d) {
                    ExceptionDecision.approve => FilledButton(
                        key: Key('ex-approve-${e.id}'),
                        onPressed: _busy ? null : () => _decide(d),
                        child: const Text('Approve'),
                      ),
                    ExceptionDecision.reject => OutlinedButton(
                        key: Key('ex-reject-${e.id}'),
                        style: OutlinedButton.styleFrom(foregroundColor: c.deal),
                        onPressed: _busy ? null : () => _decide(d),
                        child: const Text('Reject'),
                      ),
                    ExceptionDecision.acknowledge => FilledButton.tonal(
                        key: Key('ex-ack-${e.id}'),
                        onPressed: _busy ? null : () => _decide(d),
                        child: const Text('Acknowledge'),
                      ),
                    ExceptionDecision.unknown => const SizedBox.shrink(),
                  },
              ],
            ),
          ],
          if (e.decidedBy != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                [e.status.label, 'by ${e.decidedBy!.name}', placedAt(e.decidedAt), ?e.decisionNote].join(' · '),
                style: TextStyle(fontSize: 12.5, color: c.muted),
              ),
            ),
        ],
      ),
    );
  }
}

/// "just now", "12 min ago", "8 h ago", "2 days ago".
String _ago(int minutes) {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return '$minutes min ago';
  if (minutes < 60 * 24) return '${minutes ~/ 60} h ago';
  final d = minutes ~/ (60 * 24);
  return '$d ${d == 1 ? 'day' : 'days'} ago';
}
