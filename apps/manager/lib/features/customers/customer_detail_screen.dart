import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/customers.dart';
import '../../models/finance.dart' show RefundItem, RefundStatus;
import '../../models/offers.dart' show newActionId;
import '../../models/outcome.dart';
import '../../state/customers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/contact_buttons.dart';
import '../marketing/form_bits.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/reason_dialog.dart';
import 'contact_reveal_sheet.dart';
import 'customer_labels.dart';

class CustomerDetailScreen extends ConsumerWidget {
  const CustomerDetailScreen({super.key, required this.customerId});
  final String customerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Customer'), backgroundColor: c.bg),
      body: CustomerDetailBody(customerId: customerId),
    );
  }
}

/// One customer (§10.1–10.8): permitted details with a masked phone and an
/// audited reveal, their orders, complaints, refunds and feedback, and
/// suspend / restrict / reactivate with a reason.
class CustomerDetailBody extends ConsumerStatefulWidget {
  const CustomerDetailBody({super.key, required this.customerId});
  final String customerId;

  @override
  ConsumerState<CustomerDetailBody> createState() => _CustomerDetailBodyState();
}

class _CustomerDetailBodyState extends ConsumerState<CustomerDetailBody> with WidgetsBindingObserver {
  /// The revealed contact lives only in this screen's memory — never stored, and
  /// gone after [_revealFor], when the app is left, or when the manager hides it.
  ContactReveal? _contact;
  bool _busy = false;
  Timer? _hideTimer;
  static const _revealFor = Duration(seconds: 30);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    _hideTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // A number left on a screen the manager walked away from is a number on a screen.
    if (state != AppLifecycleState.resumed) _hideContact();
  }

  void _showContact(ContactReveal c) {
    _hideTimer?.cancel();
    setState(() => _contact = c);
    _hideTimer = Timer(_revealFor, _hideContact);
  }

  void _hideContact() {
    _hideTimer?.cancel();
    if (mounted && _contact != null) setState(() => _contact = null);
  }

  @override
  Widget build(BuildContext context) {
    final value = ref.watch(customerDetailProvider(widget.customerId));
    return AsyncView<CustomerDetail>(
      value: value,
      onRetry: () => ref.invalidate(customerDetailProvider(widget.customerId)),
      builder: (x) => _body(context, x),
    );
  }

  Widget _body(BuildContext context, CustomerDetail x) {
    final c = context.colors;
    final id = widget.customerId;
    Widget fig(String v, String label) => SizedBox(
          width: 110,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(v, style: dataStyle(context, size: 16, weight: FontWeight.w700)),
            Text(label, style: TextStyle(fontSize: 12, color: c.muted)),
          ]),
        );
    final a = x.allowed;
    return RefreshIndicator(
      onRefresh: () async {
        await ref.read(customerDetailProvider(id).notifier).refresh();
        ref.invalidate(customerComplaintsProvider(id));
        ref.invalidate(customerRefundsProvider(id));
        ref.invalidate(customerFeedbackProvider(id));
      },
      child: ListView(
        key: const Key('customer-detail'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 40),
        children: [
          Text(x.displayName, style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: c.ink)),
          const SizedBox(height: 4),
          Wrap(spacing: 12, runSpacing: 4, children: [
            StatusText(x.status.label, color: customerStatusColor(c, x.status), size: 13.5),
            Text('ID ${x.shortId}', style: dataStyle(context, size: 12.5, weight: FontWeight.w500)),
            if (x.memberSince != null) Text('Since ${istText(x.memberSince, time: false)}', style: TextStyle(color: c.muted, fontSize: 12.5)),
          ]),
          if (x.status != CustomerStatus.active) ...[
            const SizedBox(height: 6),
            Text(
              '${x.status.explanation}${x.statusReason == null ? '' : ' Reason: ${x.statusReason}'}'
              '${x.statusChangedBy == null ? '' : ' — ${x.statusChangedBy!.name}, ${istText(x.statusChangedAt)}'}',
              style: TextStyle(color: c.ink, fontSize: 13.5),
            ),
          ],
          FormSection(title: 'Contact', children: [
            if (_contact == null)
              Row(children: [
                Expanded(child: Text(x.phoneMasked ?? 'No phone on file', style: dataStyle(context, size: 15, weight: FontWeight.w600))),
                if (a.revealContact)
                  OutlinedButton.icon(
                    key: const Key('contact-reveal'),
                    onPressed: _busy ? null : _reveal,
                    icon: const Icon(Icons.visibility_outlined, size: 18),
                    label: const Text('Show'),
                  ),
              ])
            else ...[
              if (_contact!.phone != null)
                Row(children: [
                  Expanded(child: SelectableText(_contact!.phone!, style: dataStyle(context, size: 16, weight: FontWeight.w700))),
                  IconButton(
                    tooltip: 'Call',
                    onPressed: () => ref.read(urlOpenerProvider)(Uri(scheme: 'tel', path: _contact!.phone!)),
                    icon: const Icon(Icons.call_outlined),
                  ),
                  IconButton(
                    tooltip: 'Copy',
                    onPressed: () async {
                      await Clipboard.setData(ClipboardData(text: _contact!.phone!));
                      if (context.mounted) showSnack(context, 'Copied.');
                    },
                    icon: const Icon(Icons.copy_outlined),
                  ),
                ]),
              if (_contact!.email != null) SelectableText(_contact!.email!),
              if (_contact!.phone == null && _contact!.email == null) Text('No contact details on file.', style: TextStyle(color: c.muted, fontSize: 13.5)),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  key: const Key('contact-hide'),
                  onPressed: _hideContact,
                  icon: const Icon(Icons.visibility_off_outlined, size: 18),
                  label: const Text('Hide (clears itself in 30 s)'),
                ),
              ),
            ],
            if (x.localities.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text('Orders to: ${x.localities.join(' · ')}', style: TextStyle(color: c.muted, fontSize: 13)),
              ),
          ]),
          FormSection(title: 'Orders', children: [
            Wrap(spacing: 14, runSpacing: 12, children: [
              fig(count(x.orders), 'Orders'),
              fig(rupees(x.spent), 'Spent'),
              fig(rupees(x.aov), 'Average order'),
              fig(count(x.cancelledOrders), 'Cancelled'),
              fig(x.avgRatingGiven == null ? '—' : x.avgRatingGiven!.toStringAsFixed(1), 'Avg rating given'),
            ]),
            const SizedBox(height: 6),
            Text(
              'First order ${istText(x.firstOrderAt, time: false)} · last ${istText(x.lastOrderAt, time: false)}',
              style: TextStyle(fontSize: 12.5, color: c.muted),
            ),
            ListTile(
              key: const Key('customer-orders'),
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.receipt_long_outlined, color: c.accent),
              title: const Text('See their orders'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => GoRouter.maybeOf(context)?.push(Uri(path: '/orders', queryParameters: {
                'customer': id,
                'customerName': x.displayName,
              }).toString()),
            ),
          ]),
          _Complaints(customerId: id, open: x.openComplaints),
          _Refunds(customerId: id, canDecide: a.decideRefunds),
          _Feedback(customerId: id),
          if (a.suspend || a.restrict || a.reactivate)
            FormSection(title: 'Account', children: [
              if (a.restrict && x.status == CustomerStatus.active)
                OutlinedButton(
                  key: const Key('customer-restrict'),
                  onPressed: _busy ? null : () => _act(x, CustomerActionKind.restrict),
                  child: const Text('Restrict (no ordering)'),
                ),
              if (a.suspend && x.status != CustomerStatus.suspended) ...[
                const SizedBox(height: 8),
                OutlinedButton(
                  key: const Key('customer-suspend'),
                  onPressed: _busy ? null : () => _act(x, CustomerActionKind.suspend),
                  child: const Text('Suspend'),
                ),
              ],
              if (a.reactivate && x.status != CustomerStatus.active) ...[
                const SizedBox(height: 8),
                FilledButton(
                  key: const Key('customer-reactivate'),
                  onPressed: _busy ? null : () => _act(x, CustomerActionKind.reactivate),
                  child: const Text('Reactivate'),
                ),
              ],
            ]),
        ],
      ),
    );
  }

  Future<void> _reveal() async {
    final picked = await showContactRevealSheet(context);
    if (picked == null || !mounted) return;
    await _sendReveal(picked.$1, picked.$2, newActionId());
  }

  Future<void> _sendReveal(ContactReason reason, String? note, String actionId) async {
    setState(() => _busy = true);
    try {
      final out = await ref.read(customersRepoProvider).revealContact(widget.customerId, reason, note: note, clientActionId: actionId);
      if (!mounted) return;
      switch (out) {
        case Applied(:final value?):
          _showContact(value);
        case Applied():
          showSnack(context, "The contact didn't come back. Try again.");
        case Refused(:final code):
          showSnack(context, code == 'permission_denied' || code == 'forbidden' ? "You don't have permission to see contact details." : customerRefusal(code));
      }
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text(e.friendly),
          action: SnackBarAction(label: 'Retry', onPressed: () => _sendReveal(reason, note, actionId)),
        ));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _act(CustomerDetail x, CustomerActionKind kind) async {
    final reason = await showReasonDialog(
      context,
      title: '${kind.label} ${x.displayName}?',
      message: kind.explanation,
      quickPicks: switch (kind) {
        CustomerActionKind.suspend => const ['Repeated fake orders', 'Abusive to riders or staff', 'Payment fraud'],
        CustomerActionKind.restrict => const ['Too many cancellations', 'Unpaid cash orders', 'Under review'],
        CustomerActionKind.reactivate => const ['Issue resolved', 'Reviewed and cleared'],
      },
      submitLabel: kind.label,
    );
    if (reason == null || !mounted) return;
    await _sendAct(CustomerAction(kind: kind, expected: x.status, reason: reason));
  }

  Future<void> _sendAct(CustomerAction a) async {
    setState(() => _busy = true);
    try {
      final out = await ref.read(customerDetailProvider(widget.customerId).notifier).act(a);
      if (!mounted) return;
      switch (out) {
        case Applied():
          showSnack(context, switch (a.kind) {
            CustomerActionKind.suspend => 'Suspended. They are signed out and cannot order.',
            CustomerActionKind.restrict => 'Restricted. They cannot place orders.',
            CustomerActionKind.reactivate => 'Reactivated.',
          });
          ref.invalidate(customerListProvider);
        case Refused(:final code):
          showSnack(context, customerRefusal(code));
      }
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      final text = e.code == 'effect_failed' ? 'Saved, but the sign-in block failed — try again.' : e.friendly;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text(text),
          duration: const Duration(seconds: 10),
          action: SnackBarAction(label: 'Retry', onPressed: () => _sendAct(a)),
        ));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}

class _Complaints extends ConsumerWidget {
  const _Complaints({required this.customerId, required this.open});
  final String customerId;
  final int open;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final v = ref.watch(customerComplaintsProvider(customerId));
    return FormSection(title: 'Complaints${open > 0 ? ' ($open open)' : ''}', children: [
      v.when(
        skipLoadingOnRefresh: true,
        loading: () => const LinearProgressIndicator(),
        error: (e, _) => TextButton(onPressed: () => ref.invalidate(customerComplaintsProvider(customerId)), child: const Text("Couldn't load — retry")),
        data: (p) => p.items.isEmpty
            ? Text('None.', style: TextStyle(color: c.muted))
            : Column(children: [
                for (final t in p.items)
                  ListTile(
                    key: Key('complaint-${t.id}'),
                    contentPadding: EdgeInsets.zero,
                    title: Text('#${t.number} ${t.subject}', maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text('${t.status.label} · ${istText(t.createdAt)}'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => GoRouter.maybeOf(context)?.push('/more/tickets/${t.id}'),
                  ),
              ]),
      ),
    ]);
  }
}

class _Refunds extends ConsumerWidget {
  const _Refunds({required this.customerId, required this.canDecide});
  final String customerId;
  final bool canDecide;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final v = ref.watch(customerRefundsProvider(customerId));
    return FormSection(title: 'Refunds', children: [
      v.when(
        skipLoadingOnRefresh: true,
        loading: () => const LinearProgressIndicator(),
        error: (e, _) => TextButton(onPressed: () => ref.invalidate(customerRefundsProvider(customerId)), child: const Text("Couldn't load — retry")),
        data: (p) => p.items.isEmpty
            ? Text('None.', style: TextStyle(color: c.muted))
            : Column(children: [for (final r in p.items) _refundRow(context, r)]),
      ),
    ]);
  }

  Widget _refundRow(BuildContext context, RefundItem r) {
    final pending = r.status == RefundStatus.pending;
    return ListTile(
      key: Key('refund-${r.id}'),
      contentPadding: EdgeInsets.zero,
      title: Text('${rupees(r.amount)} · order ${r.order.code}'),
      subtitle: Text('${r.status.label}${r.reason == null ? '' : ' · ${r.reason}'}', maxLines: 2, overflow: TextOverflow.ellipsis),
      trailing: pending && canDecide
          ? TextButton(
              key: Key('refund-decide-${r.id}'),
              onPressed: () => GoRouter.maybeOf(context)?.push(Uri(path: '/finance/refunds', queryParameters: {'id': r.id}).toString()),
              child: const Text('Decide'),
            )
          : null,
    );
  }
}

class _Feedback extends ConsumerWidget {
  const _Feedback({required this.customerId});
  final String customerId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final v = ref.watch(customerFeedbackProvider(customerId));
    String stars(int n) => 'Rated ${n.clamp(0, 5)}/5';
    return FormSection(title: 'Ratings and feedback they gave', children: [
      v.when(
        skipLoadingOnRefresh: true,
        loading: () => const LinearProgressIndicator(),
        error: (e, _) => TextButton(onPressed: () => ref.invalidate(customerFeedbackProvider(customerId)), child: const Text("Couldn't load — retry")),
        data: (f) => f.reviews.isEmpty && f.riderRatings.isEmpty
            ? Text('None yet.', style: TextStyle(color: c.muted))
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                for (final r in f.reviews)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('${stars(r.rating)}  ${r.vendor.name}${r.orderCode == null ? '' : ' · ${r.orderCode}'}',
                          style: TextStyle(color: c.ink, fontWeight: FontWeight.w600)),
                      if (r.comment != null) Text(r.comment!, style: TextStyle(color: c.ink)),
                      if (r.reply != null) Text('Shop replied: ${r.reply}', style: TextStyle(color: c.muted, fontSize: 12.5)),
                      if (r.flagged) Text('Flagged', style: TextStyle(color: c.deal, fontSize: 12.5)),
                    ]),
                  ),
                for (final r in f.riderRatings)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Text(
                      '${stars(r.rating)}  Rider ${r.riderName}${r.riderCode == null ? '' : ' (${r.riderCode})'}'
                      '${r.comment == null ? '' : ' — ${r.comment}'}',
                      style: TextStyle(color: c.ink),
                    ),
                  ),
              ]),
      ),
    ]);
  }
}
