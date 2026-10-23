import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/marketing.dart';
import '../../models/outcome.dart';
import '../../state/marketing.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/contact_buttons.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/reason_dialog.dart';
import 'form_bits.dart';
import 'marketing_labels.dart';
import 'request_decide_screen.dart';

class RequestDetailScreen extends ConsumerWidget {
  const RequestDetailScreen({super.key, required this.requestId});
  final String requestId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final title = ref.watch(requestDetailProvider(requestId)).value?.request.number;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(title == null ? 'Request' : 'Request #$title'), backgroundColor: c.bg),
      body: RequestDetailBody(requestId: requestId),
    );
  }
}

/// One marketing request: everything the vendor asked for, what came of it,
/// and the decision buttons (§8.1–8.3, §8.7).
class RequestDetailBody extends ConsumerWidget {
  const RequestDetailBody({super.key, required this.requestId});
  final String requestId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(requestDetailProvider(requestId));
    return AsyncView<RequestBundle>(
      value: value,
      onRetry: () => ref.invalidate(requestDetailProvider(requestId)),
      builder: (b) => _Body(bundle: b, providerId: requestId),
    );
  }
}

class _Body extends ConsumerStatefulWidget {
  const _Body({required this.bundle, required this.providerId});
  final RequestBundle bundle;

  /// The id the screen watches the request under (the route's).
  final String providerId;

  @override
  ConsumerState<_Body> createState() => _BodyState();
}

class _BodyState extends ConsumerState<_Body> {
  bool _busy = false;

  MarketingRequest get r => widget.bundle.request;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final b = widget.bundle;
    final pending = r.status == RequestStatus.pending;
    final other = r.type == MarketingType.other;
    Widget fact(String label, String value, {Key? key}) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 130, child: Text(label, style: TextStyle(color: c.muted, fontSize: 13.5))),
            Expanded(child: Text(value, key: key, style: TextStyle(color: c.ink, fontSize: 14))),
          ]),
        );

    return RefreshIndicator(
      onRefresh: () => ref.read(requestDetailProvider(widget.providerId).notifier).refresh(),
      child: ListView(
        key: const Key('request-detail'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          Text(r.title, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: c.ink)),
          const SizedBox(height: 6),
          Wrap(spacing: 12, runSpacing: 4, children: [
            StatusText(r.status.label, color: requestStatusColor(c, r.status), size: 13.5),
            Text(r.type.label, style: TextStyle(color: c.muted)),
          ]),
          const SizedBox(height: 12),
          fact('Vendor', r.vendor.name),
          fact('Zone', r.zone.name),
          fact('Asked by', r.requestedBy.isVendor ? '${r.requestedBy.name} (vendor)' : '${r.requestedBy.name} (recorded by Deligro)'),
          fact('Received', istText(r.createdAt)),
          if (r.preferredStart != null || r.preferredEnd != null)
            fact('Preferred dates', '${istDay(r.preferredStart)} – ${istDay(r.preferredEnd)}'),
          fact('Budget', r.budget == null ? 'Not given' : rupees(r.budget!)),
          if (r.details.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(r.details, style: TextStyle(color: c.ink, fontSize: 14.5, height: 1.35)),
          ],
          if (r.items.isNotEmpty)
            FormSection(title: 'Dishes', children: [
              for (final i in r.items) Padding(padding: const EdgeInsets.symmetric(vertical: 3), child: Text('• ${i.name}')),
            ]),
          if (r.proposedOffer != null)
            FormSection(title: 'Offer they propose', children: [
              fact('Code', r.proposedOffer!.code),
              fact('Discount', r.proposedOffer!.summary),
              fact('Minimum order', rupees(r.proposedOffer!.minOrder)),
              fact('Expires', istText(r.proposedOffer!.expiresAt)),
            ]),
          if (r.attachmentUrl != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: OutlinedButton.icon(
                key: const Key('request-attachment'),
                onPressed: () => ref.read(urlOpenerProvider)(Uri.parse(r.attachmentUrl!)),
                icon: const Icon(Icons.attach_file),
                label: const Text('Open attachment'),
              ),
            ),
          if (r.decidedBy != null || r.remarks != null)
            FormSection(title: 'Decision', children: [
              if (r.decidedBy != null) fact('By', '${r.decidedBy!.name}, ${istText(r.decidedAt)}'),
              if (r.remarks != null) fact('Remarks', r.remarks!, key: const Key('request-remarks')),
            ]),
          if (b.campaign != null)
            FormSection(title: 'Campaign', children: [
              ListTile(
                key: const Key('request-campaign'),
                contentPadding: EdgeInsets.zero,
                leading: Icon(campaignIcon(b.campaign!.kind), color: c.accent),
                title: Text(b.campaign!.title),
                subtitle: Text('${campaignStateLabel(b.campaign!)} · ${istText(b.campaign!.startsAt, time: false)} – ${istText(b.campaign!.endsAt, time: false)}'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => GoRouter.maybeOf(context)?.push('/more/marketing/campaigns/${b.campaign!.id}'),
              ),
            ]),
          if (b.offer != null)
            FormSection(title: 'Offer', children: [
              ListTile(
                key: const Key('request-offer'),
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.local_offer_outlined, color: c.accent),
                title: Text(b.offer!.code),
                subtitle: Text('${b.offer!.summary} · ${b.offer!.state.label}'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => GoRouter.maybeOf(context)?.push('/more/offers/${b.offer!.code}'),
              ),
            ]),
          const SizedBox(height: 20),
          if (pending)
            Row(children: [
              Expanded(
                child: OutlinedButton(
                  key: const Key('request-reject'),
                  onPressed: _busy ? null : _reject,
                  child: const Text('Reject'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  key: const Key('request-approve'),
                  onPressed: _busy ? null : _approve,
                  child: const Text('Approve…'),
                ),
              ),
            ]),
          if (other && r.status == RequestStatus.approved)
            FilledButton(
              key: const Key('request-in-progress'),
              onPressed: _busy ? null : () => _progress(RequestStatus.inProgress),
              child: const Text('Mark in progress'),
            ),
          if (other && r.status == RequestStatus.inProgress)
            FilledButton(
              key: const Key('request-complete'),
              onPressed: _busy ? null : () => _progress(RequestStatus.completed),
              child: const Text('Mark completed'),
            ),
        ],
      ),
    );
  }

  Future<void> _approve() async {
    final done = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => RequestDecideScreen(bundle: widget.bundle)),
    );
    if (done == true && mounted) await ref.read(requestDetailProvider(widget.providerId).notifier).refresh();
  }

  Future<void> _reject() async {
    final remarks = await showReasonDialog(
      context,
      title: 'Reject this request?',
      message: 'The vendor sees your remarks in the Partner app.',
      hint: 'Remarks for the vendor',
      quickPicks: const ['Dates not available', 'Budget too low', 'Not a fit for the feed right now'],
      submitLabel: 'Reject',
      maxLength: 1000,
    );
    if (remarks == null || !mounted) return;
    await _send(RequestDecision.reject(remarks: remarks));
  }

  Future<void> _send(RequestDecision d) async {
    setState(() => _busy = true);
    final Outcome<RequestBundle> out;
    try {
      out = await ref.read(requestDetailProvider(widget.providerId).notifier).decide(d);
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text(e.friendly),
          action: SnackBarAction(label: 'Retry', onPressed: () => _send(d)),
        ));
      return;
    }
    if (!mounted) return;
    setState(() => _busy = false);
    switch (out) {
      case Applied():
        showSnack(context, d.approve ? 'Request approved.' : 'Request rejected. The vendor has been told.');
        ref.invalidate(requestListProvider);
      case Refused(:final code, :final extra):
        showSnack(context, code == 'stale' ? 'Someone else decided this request. Showing the latest.' : marketingRefusal(code, extra));
    }
  }

  Future<void> _progress(RequestStatus to) async {
    final remarks = await showReasonDialog(
      context,
      title: to == RequestStatus.completed ? 'Mark completed?' : 'Mark in progress?',
      hint: 'Remarks',
      submitLabel: 'Save',
      maxLength: 1000,
    );
    if (remarks == null || !mounted) return;
    setState(() => _busy = true);
    try {
      final out = await ref.read(requestDetailProvider(widget.providerId).notifier).progress(RequestProgress(status: to, remarks: remarks));
      if (!mounted) return;
      if (out case Refused(:final code, :final extra)) showSnack(context, marketingRefusal(code, extra));
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.friendly);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}
