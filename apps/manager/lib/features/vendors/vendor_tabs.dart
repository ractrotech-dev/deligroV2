import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:latlong2/latlong.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/outcome.dart';
import '../../models/tickets.dart';
import '../../models/vendors.dart';
import '../../state/providers.dart';
import '../../state/vendors.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/contact_buttons.dart';
import '../../widgets/document_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/order_mini_map.dart';
import '../orders/reason_dialog.dart';
import '../support/ticket_labels.dart';
import 'vendor_actions.dart';

final _day = DateFormat('d MMM yyyy');
String _pct(double r) => '${(r * 100).toStringAsFixed(1)}%';
String _minutes(double? m) => m == null ? '—' : '${m.toStringAsFixed(1)} min';

/// A titled group of rows, separated by a hairline (not a box).
class InfoSection extends StatelessWidget {
  const InfoSection({super.key, required this.title, required this.children, this.trailing});
  final String title;
  final List<Widget> children;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(top: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  title.toUpperCase(),
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.6, color: c.muted),
                ),
              ),
              ?trailing,
            ],
          ),
          Divider(color: c.line, height: 14),
          ...children,
        ],
      ),
    );
  }
}

/// "Label …… value", one fact per row.
class FactRow extends StatelessWidget {
  const FactRow(this.label, this.value, {super.key, this.mono = false});
  final String label;
  final String value;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 150,
            child: Padding(
              padding: const EdgeInsets.only(right: 10),
              child: Text(label, style: TextStyle(color: c.muted, fontSize: 13.5)),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: mono
                  ? dataStyle(context, size: 13.5)
                  : TextStyle(color: c.ink, fontSize: 13.5, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}

/// A figure with its label underneath, for a row of headline numbers.
class Figure extends StatelessWidget {
  const Figure(this.value, this.label, {super.key});
  final String value;
  final String label;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(value, style: dataStyle(context, size: 17, weight: FontWeight.w700)),
      const SizedBox(height: 2),
      Text(label, style: TextStyle(fontSize: 12, color: context.colors.muted)),
    ],
  );
}

// ── Overview ──────────────────────────────────────────────────────────────

class VendorOverviewTab extends ConsumerWidget {
  const VendorOverviewTab({super.key, required this.vendor});
  final VendorDetail vendor;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final v = vendor;
    final h = v.hours;
    final p = v.performance;
    final a = v.address;
    final call = v.contact.callNumber;
    String weekday(String d) => d.isEmpty ? d : '${d[0].toUpperCase()}${d.substring(1)}';

    return RefreshIndicator(
      onRefresh: () => ref.read(vendorDetailProvider(v.id).notifier).refresh(),
      // Built in one go (it is short), so every section exists for search
      // and accessibility, not just the ones on screen.
      child: SingleChildScrollView(
        key: const Key('vendor-overview'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (v.description != null) ...[
              const SizedBox(height: 14),
              Text(v.description!, style: TextStyle(color: c.ink, height: 1.4)),
            ],
            InfoSection(
              title: 'Contact',
              children: [
                if (v.contact.ownerName != null) FactRow('Owner', v.contact.ownerName!),
                if (v.contact.shopPhone != null) FactRow('Shop phone', v.contact.shopPhone!, mono: true),
                if (v.contact.ownerMobile != null) FactRow('Owner mobile', v.contact.ownerMobile!, mono: true),
                if (v.contact.ownerEmail != null) FactRow('Email', v.contact.ownerEmail!),
                if (call != null) ...[const SizedBox(height: 8), ContactButtons(phone: call)],
              ],
            ),
            InfoSection(
              title: 'Address',
              children: [
                if (a.line != null) FactRow('Address', a.line!),
                if (a.landmark != null) FactRow('Landmark', a.landmark!),
                if (a.pincode != null) FactRow('Pincode', a.pincode!, mono: true),
                if (a.pinned) ...[
                  const SizedBox(height: 8),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(radiusBlock),
                    child: OrderMiniMap(shop: LatLng(a.lat!, a.lng!), height: 160),
                  ),
                ] else
                  Text('Not pinned on the map yet.', style: TextStyle(color: c.deal, fontSize: 13)),
              ],
            ),
            InfoSection(
              title: 'Hours and availability',
              children: [
                FactRow(
                  'Hours',
                  h.opening == null || h.closing == null ? 'Not set' : '${h.opening} – ${h.closing}',
                  mono: true,
                ),
                FactRow('Weekly off', h.weeklyOff.isEmpty ? 'None' : h.weeklyOff.map(weekday).join(', ')),
                if (h.closedUntil != null)
                  FactRow('Closed until', DateFormat('d MMM, h:mm a').format(h.closedUntil!.toLocal())),
                for (final hol in h.holidays)
                  FactRow('Holiday', '${hol.from} – ${hol.to}${hol.note == null ? '' : ' (${hol.note})'}'),
                FactRow('Delivery', h.deliveryAvailable ? 'Yes' : 'No'),
                FactRow('Self pickup', h.selfPickup ? 'Yes' : 'No'),
                if (h.prepMinutesDefault != null) FactRow('Usual prep time', '${h.prepMinutesDefault} min', mono: true),
              ],
            ),
            InfoSection(
              title: 'Registration',
              children: [
                if (v.summary.category != null) FactRow('Category', v.summary.category!),
                FactRow(
                  'FSSAI number',
                  v.registration.fssaiNumber ?? 'Not given',
                  mono: v.registration.fssaiNumber != null,
                ),
                if (v.registration.onboardedAt != null)
                  FactRow('Joined', _day.format(v.registration.onboardedAt!.toLocal())),
                if (v.registration.tcAcceptedAt != null)
                  FactRow(
                    'Terms accepted',
                    '${_day.format(v.registration.tcAcceptedAt!.toLocal())}${v.registration.tcVersion == null ? '' : ' (v${v.registration.tcVersion})'}',
                  ),
              ],
            ),
            InfoSection(
              title: 'Last 30 days',
              children: [
                Wrap(
                  spacing: 24,
                  runSpacing: 14,
                  children: [
                    Figure(count(p.orders), 'Orders'),
                    Figure(rupees(p.sales), 'Sales'),
                    Figure(rupees(p.aov), 'Average order'),
                    Figure(_pct(p.cancellationRate), 'Cancelled'),
                    Figure(_pct(p.rejectionRate), 'Rejected by shop'),
                    Figure(_minutes(p.avgAcceptMinutes), 'Time to accept'),
                    Figure(_minutes(p.avgPrepMinutes), 'Prep time'),
                  ],
                ),
                const SizedBox(height: 14),
                RatingDistribution(distribution: p.ratingDistribution),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton.icon(
                      key: const Key('vendor-orders-link'),
                      onPressed: () => context.push(Uri(path: '/orders', queryParameters: {'vendor': v.id}).toString()),
                      icon: const Icon(Icons.receipt_long_outlined, size: 18),
                      label: const Text('Orders'),
                    ),
                    OutlinedButton.icon(
                      key: const Key('vendor-stats-link'),
                      onPressed: () => context.push(
                        Uri(path: '/stats', queryParameters: {'vendor': v.id, 'name': v.name}).toString(),
                      ),
                      icon: const Icon(Icons.insights_outlined, size: 18),
                      label: const Text('Sales statistics'),
                    ),
                  ],
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Five bars, 5★ to 1★.
class RatingDistribution extends StatelessWidget {
  const RatingDistribution({super.key, required this.distribution});
  final Map<int, int> distribution;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final total = distribution.values.fold<int>(0, (a, b) => a + b);
    if (total == 0) return Text('No ratings in this period.', style: TextStyle(color: c.muted, fontSize: 13));
    return Column(
      children: [
        for (var s = 5; s >= 1; s--)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              children: [
                SizedBox(width: 18, child: Text('$s', style: dataStyle(context, size: 12.5))),
                Icon(Icons.star_rounded, size: 14, color: c.pop),
                const SizedBox(width: 8),
                Expanded(
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: LinearProgressIndicator(
                      value: (distribution[s] ?? 0) / total,
                      minHeight: 8,
                      backgroundColor: c.surface2,
                      color: c.pop,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 34,
                  child: Text(
                    '${distribution[s] ?? 0}',
                    textAlign: TextAlign.right,
                    style: dataStyle(context, size: 12.5),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

// ── Documents ─────────────────────────────────────────────────────────────

Color docStatusColor(AppColors c, DocStatus s) => switch (s) {
  DocStatus.verified => c.green,
  DocStatus.pending => c.amberText,
  DocStatus.rejected => c.deal,
  DocStatus.unknown => c.muted,
};

class VendorDocumentsTab extends ConsumerStatefulWidget {
  const VendorDocumentsTab({super.key, required this.vendor});
  final VendorDetail vendor;

  @override
  ConsumerState<VendorDocumentsTab> createState() => _VendorDocumentsTabState();
}

class _VendorDocumentsTabState extends ConsumerState<VendorDocumentsTab> {
  bool _uploading = false;

  VendorDetail get v => widget.vendor;

  Future<void> _open(VendorDocument d) async {
    final String url;
    try {
      url = await ref.read(vendorsRepoProvider).documentUrl(v.id, d.id);
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.friendly);
      return;
    }
    if (!mounted) return;
    if (d.isPdf) {
      await ref.read(urlOpenerProvider)(Uri.parse(url));
      return;
    }
    await showDialog<void>(
      context: context,
      builder: (ctx) => Dialog(
        insetPadding: const EdgeInsets.all(12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: Text(d.type.label),
              subtitle: Text(d.fileName),
              trailing: IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(ctx)),
            ),
            Flexible(
              child: InteractiveViewer(
                child: Image.network(
                  url,
                  fit: BoxFit.contain,
                  errorBuilder: (_, _, _) => const Padding(
                    padding: EdgeInsets.all(24),
                    child: Text("Couldn't load the image. The link lasts a minute — open it again."),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _review(VendorDocument d, {required bool verify}) async {
    final reason = await showReasonDialog(
      context,
      title: verify ? 'Verify ${d.type.label}?' : 'Reject ${d.type.label}?',
      quickPicks: verify ? VendorPicks.verifyDocument : VendorPicks.rejectDocument,
      hint: verify ? 'Note' : 'What is wrong with it (the vendor sees this)',
      submitLabel: verify ? 'Verify' : 'Reject',
    );
    if (reason == null || !mounted) return;
    await sendVendorAction(
      context,
      ref,
      v.id,
      verify ? VerifyDocument(documentId: d.id, reason: reason) : RejectDocument(documentId: d.id, reason: reason),
      doneText: verify ? 'Document verified.' : 'Document rejected. The vendor has been told.',
    );
  }

  Future<void> _upload() async {
    final type = await pickOne<DocType>(
      context,
      title: 'Which document?',
      options: [for (final t in DocType.uploadable) (t, t.label, null)],
    );
    if (type == null || !mounted) return;
    final file = await ref.read(documentPickerProvider)(context);
    if (file == null || !mounted) return;
    final problem = await documentFileProblem(file);
    if (problem != null) {
      if (mounted) showSnack(context, problem);
      return;
    }
    final id = const Uuid().v4();
    setState(() => _uploading = true);
    try {
      final out = await ref.read(vendorsRepoProvider).upload(v.id, type.wire, file, id);
      if (!mounted) return;
      switch (out) {
        case Applied():
          showSnack(context, '${type.label} uploaded.');
          await ref.read(vendorDetailProvider(v.id).notifier).refresh();
        case Refused(code: 'bad_file'):
          showSnack(context, 'The server refused that file. Use a JPEG, PNG, WebP or PDF up to 10 MB.');
        case Refused():
          showSnack(context, vendorRefusalText(out));
      }
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.friendly);
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        if (v.allowed.uploadDocuments)
          Align(
            alignment: Alignment.centerLeft,
            child: OutlinedButton.icon(
              key: const Key('doc-upload'),
              onPressed: _uploading ? null : _upload,
              icon: _uploading
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.upload_file_outlined, size: 18),
              label: Text(_uploading ? 'Uploading…' : 'Upload a document'),
            ),
          ),
        if (v.documents.isEmpty) const EmptyLine('No documents uploaded yet.'),
        for (final d in v.documents)
          Container(
            margin: const EdgeInsets.only(top: 10),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: c.surface,
              borderRadius: BorderRadius.circular(radiusBlock),
              border: Border.all(color: c.line),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(d.isPdf ? Icons.picture_as_pdf_outlined : Icons.image_outlined, color: c.muted),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            d.type.label,
                            style: TextStyle(fontWeight: FontWeight.w700, color: c.ink),
                          ),
                          Text(
                            d.fileName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(color: c.muted, fontSize: 12.5),
                          ),
                        ],
                      ),
                    ),
                    StatusText(d.status.label, color: docStatusColor(c, d.status)),
                  ],
                ),
                if (d.remarks != null) ...[
                  const SizedBox(height: 6),
                  Text(d.remarks!, style: TextStyle(color: c.ink, fontSize: 13)),
                ],
                if (d.reviewedBy != null || d.uploadedAt != null) ...[
                  const SizedBox(height: 4),
                  Text(
                    [
                      if (d.uploadedAt != null) 'Uploaded ${_day.format(d.uploadedAt!.toLocal())}',
                      if (d.reviewedBy != null)
                        'reviewed by ${d.reviewedBy!.name}${d.reviewedAt == null ? '' : ' on ${_day.format(d.reviewedAt!.toLocal())}'}',
                    ].join(' · '),
                    style: TextStyle(color: c.muted, fontSize: 12),
                  ),
                ],
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    TextButton.icon(
                      key: Key('doc-open-${d.id}'),
                      onPressed: () => _open(d),
                      icon: const Icon(Icons.open_in_new, size: 16),
                      label: const Text('Open'),
                    ),
                    if (v.allowed.reviewDocuments && d.status != DocStatus.verified)
                      FilledButton.tonal(
                        key: Key('doc-verify-${d.id}'),
                        onPressed: () => _review(d, verify: true),
                        child: const Text('Verify'),
                      ),
                    if (v.allowed.reviewDocuments && d.status != DocStatus.rejected)
                      OutlinedButton(
                        key: Key('doc-reject-${d.id}'),
                        style: OutlinedButton.styleFrom(foregroundColor: c.deal),
                        onPressed: () => _review(d, verify: false),
                        child: const Text('Reject'),
                      ),
                  ],
                ),
              ],
            ),
          ),
      ],
    );
  }
}

// ── Reviews ───────────────────────────────────────────────────────────────

class VendorReviewsTab extends ConsumerStatefulWidget {
  const VendorReviewsTab({super.key, required this.vendorId});
  final String vendorId;

  @override
  ConsumerState<VendorReviewsTab> createState() => _VendorReviewsTabState();
}

class _VendorReviewsTabState extends ConsumerState<VendorReviewsTab> {
  final _items = <ReviewItem>[];
  String? _next;
  bool _loading = true;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool more = false}) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await ref.read(vendorsRepoProvider).reviews(widget.vendorId, cursor: more ? _next : null);
      if (!mounted) return;
      setState(() {
        if (!more) _items.clear();
        final seen = {for (final r in _items) r.id};
        _items.addAll(page.items.where((r) => !seen.contains(r.id)));
        _next = page.nextCursor;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    if (_items.isEmpty && _loading) return const Center(child: CircularProgressIndicator());
    if (_items.isEmpty && _error != null) return ErrorRetry(error: _error!, onRetry: _load);
    if (_items.isEmpty) return const EmptyLine('No reviews yet.');
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        itemCount: _items.length + (_next != null ? 1 : 0),
        separatorBuilder: (_, _) => Divider(color: c.line, height: 20),
        itemBuilder: (context, i) {
          if (i == _items.length) {
            return Center(
              child: TextButton(
                onPressed: _loading ? null : () => _load(more: true),
                child: const Text('Load more reviews'),
              ),
            );
          }
          final r = _items[i];
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  for (var s = 1; s <= 5; s++)
                    Icon(s <= r.rating ? Icons.star_rounded : Icons.star_outline_rounded, size: 16, color: c.pop),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      [
                        r.customerFirstName ?? 'A customer',
                        if (r.createdAt != null) _day.format(r.createdAt!.toLocal()),
                      ].join(' · '),
                      style: TextStyle(color: c.muted, fontSize: 12.5),
                    ),
                  ),
                  if (r.orderCode != null) Text(r.orderCode!, style: dataStyle(context, size: 12)),
                ],
              ),
              if (r.subRatings.given.isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(
                  r.subRatings.given.map((g) => '${g.$1} ${g.$2}/5').join(' · '),
                  style: TextStyle(color: c.muted, fontSize: 12.5),
                ),
              ],
              if (r.comment != null) ...[
                const SizedBox(height: 6),
                Text(r.comment!, style: TextStyle(color: c.ink, height: 1.35)),
              ],
              if (r.status != 'published') ...[
                const SizedBox(height: 4),
                Text('Not shown to customers (${r.status})', style: TextStyle(color: c.deal, fontSize: 12)),
              ],
              if (r.replyText != null)
                Container(
                  margin: const EdgeInsets.only(top: 8),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(10)),
                  child: Text('Shop replied: ${r.replyText}', style: TextStyle(color: c.ink, fontSize: 13)),
                ),
            ],
          );
        },
      ),
    );
  }
}

// ── Finance ───────────────────────────────────────────────────────────────

class VendorFinanceTab extends StatelessWidget {
  const VendorFinanceTab({super.key, required this.finance});
  final VendorFinance finance;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final f = finance;
    String cycle(String? s) => s == null ? 'Not set' : '${s[0].toUpperCase()}${s.substring(1)}';
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
      children: [
        InfoSection(
          title: 'Payments',
          children: [
            Wrap(
              spacing: 24,
              runSpacing: 14,
              children: [
                Figure(rupees(f.pendingPayment), 'Payment due'),
                if (f.recoverable > 0) Figure(rupees(f.recoverable), 'Owed to Deligro'),
                Figure(rupees(f.commissionThisPeriod), 'Commission this period'),
              ],
            ),
          ],
        ),
        InfoSection(
          title: 'Terms',
          children: [
            FactRow('Commission', '${f.commissionPct.toStringAsFixed(f.commissionPct % 1 == 0 ? 0 : 1)}%', mono: true),
            FactRow('GST on commission', '${f.commissionGstPct.toStringAsFixed(0)}%', mono: true),
            FactRow('Other charges', '${rupees(f.otherChargesPerOrder)} per order', mono: true),
            FactRow('Settlement cycle', cycle(f.settlementCycle)),
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('Terms are set by admin.', style: TextStyle(color: c.muted, fontSize: 12)),
            ),
          ],
        ),
        InfoSection(
          title: 'Settlements',
          children: [
            if (f.settlements.isEmpty) const EmptyLine('No settlements yet.'),
            for (final s in f.settlements)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${s.periodStart ?? '?'} – ${s.periodEnd ?? '?'}', style: dataStyle(context, size: 13)),
                          const SizedBox(height: 2),
                          Text(
                            s.status == 'paid'
                                ? 'Paid${s.paidAt == null ? '' : ' ${_day.format(s.paidAt!.toLocal())}'}${s.paymentRef == null ? '' : ' · ref ${s.paymentRef}'}'
                                : s.status == 'void'
                                ? 'Void'
                                : 'Not paid yet',
                            style: TextStyle(color: s.status == 'paid' ? c.green : c.muted, fontSize: 12.5),
                          ),
                        ],
                      ),
                    ),
                    Text(rupees(s.netPayable), style: dataStyle(context, size: 14, weight: FontWeight.w700)),
                  ],
                ),
              ),
          ],
        ),
      ],
    );
  }
}

// ── Complaints ────────────────────────────────────────────────────────────

final _complaintsProvider = FutureProvider.autoDispose.family<TicketPage, String>(
  (ref, id) => ref.read(vendorsRepoProvider).complaints(id),
  retry: (_, _) => null,
);

class VendorComplaintsTab extends ConsumerWidget {
  const VendorComplaintsTab({super.key, required this.vendorId});
  final String vendorId;

  @override
  Widget build(BuildContext context, WidgetRef ref) => AsyncView(
    value: ref.watch(_complaintsProvider(vendorId)),
    onRetry: () => ref.invalidate(_complaintsProvider(vendorId)),
    builder: (page) => page.items.isEmpty
        ? const EmptyLine('No complaints about this vendor.')
        : RefreshIndicator(
            onRefresh: () => ref.refresh(_complaintsProvider(vendorId).future),
            child: ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              itemCount: page.items.length,
              separatorBuilder: (_, _) => const SizedBox(height: 8),
              itemBuilder: (context, i) => TicketSummaryTile(
                ticket: page.items[i],
                onTap: () => context.push('/more/tickets/${page.items[i].id}'),
              ),
            ),
          ),
  );
}
