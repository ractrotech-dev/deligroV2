import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/offers.dart';
import '../../models/orders.dart' show istOffset;
import '../../models/outcome.dart';
import '../../state/offers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../marketing/form_bits.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/reason_dialog.dart';
import 'offer_form_screen.dart';
import 'offer_labels.dart';

/// One offer: its terms and where it applies, how it is used (§9.7, §9.9)
/// over a range, who changed what (§9.10), and Edit / Activate / Deactivate.
class OfferDetailScreen extends ConsumerStatefulWidget {
  const OfferDetailScreen({super.key, required this.code});
  final String code;

  @override
  ConsumerState<OfferDetailScreen> createState() => _OfferDetailScreenState();
}

class _OfferDetailScreenState extends ConsumerState<OfferDetailScreen> {
  String? _from;
  String? _to;
  bool _busy = false;

  OfferKey get _key => (code: widget.code, from: _from, to: _to);

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final value = ref.watch(offerDetailProvider(_key));
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(widget.code), backgroundColor: c.bg),
      body: AsyncView<OfferBundle>(
        value: value,
        onRetry: () => ref.invalidate(offerDetailProvider(_key)),
        builder: (b) => _body(context, b),
      ),
    );
  }

  Widget _body(BuildContext context, OfferBundle b) {
    final c = context.colors;
    final o = b.offer;
    final u = b.usage;
    Widget fact(String label, String value) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 130, child: Text(label, style: TextStyle(color: c.muted, fontSize: 13.5))),
            Expanded(child: Text(value, style: TextStyle(color: c.ink, fontSize: 14))),
          ]),
        );
    Widget fig(String key, String value, String label) => SizedBox(
          width: 140,
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(value, key: Key(key), style: dataStyle(context, size: 17, weight: FontWeight.w700)),
            const SizedBox(height: 2),
            Text(label, style: TextStyle(fontSize: 12, color: c.muted)),
          ]),
        );

    return RefreshIndicator(
      onRefresh: () => ref.read(offerDetailProvider(_key).notifier).refresh(),
      child: ListView(
        key: const Key('offer-detail'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 40),
        children: [
          Row(children: [
            Expanded(child: Text(o.label ?? o.summary, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: c.ink))),
            StatusText(o.state.label, color: offerStateColor(c, o.state), size: 13.5),
          ]),
          if (o.platformWide)
            Container(
              key: const Key('offer-platform-note'),
              margin: const EdgeInsets.only(top: 10),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
              child: Text('This offer applies everywhere. Only an admin can change it.', style: TextStyle(color: c.ink, fontSize: 13.5)),
            ),
          FormSection(title: 'Terms', children: [
            fact('Discount', o.summary),
            fact('Minimum order', rupees(o.minOrder)),
            fact('Valid', '${o.startsAt == null ? 'From creation' : istText(o.startsAt)} – ${istText(o.expiresAt)}'),
            fact('Per customer', o.maxPerCustomer == null ? 'No limit' : '${o.maxPerCustomer} use${o.maxPerCustomer == 1 ? '' : 's'}'),
            fact('Total uses', o.maxRedemptions == null ? 'No limit' : '${count(o.redemptions)} of ${count(o.maxRedemptions!)}'),
            fact('Applies to', offerScope(o)),
            if (o.items.isNotEmpty) fact('Dishes', o.items.map((i) => i.name).join(', ')),
            fact('Who pays', o.fundedBy == OfferFunding.vendor ? 'The vendor' : 'Deligro'),
            if (o.createdBy != null) fact('Created by', o.createdBy!.name),
          ]),
          if (o.campaignIds.isNotEmpty || o.requestId != null)
            FormSection(title: 'Linked', children: [
              for (final id in o.campaignIds)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(Icons.campaign_outlined, color: c.accent),
                  title: const Text('Campaign'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => GoRouter.maybeOf(context)?.push('/more/marketing/campaigns/$id'),
                ),
              if (o.requestId != null)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(Icons.inbox_outlined, color: c.accent),
                  title: const Text("The vendor's request"),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => GoRouter.maybeOf(context)?.push('/more/marketing/requests/${o.requestId}'),
                ),
            ]),
          FormSection(title: 'Usage', children: [
            Row(children: [
              Expanded(child: Text(u.from == null ? 'So far' : '${istDay(u.from)} – ${istDay(u.to)}', style: TextStyle(color: c.muted, fontSize: 13))),
              TextButton.icon(key: const Key('usage-range'), onPressed: _pickRange, icon: const Icon(Icons.date_range, size: 18), label: const Text('Range')),
            ]),
            Wrap(spacing: 22, runSpacing: 14, children: [
              fig('usage-redemptions', count(u.redemptions), 'Uses'),
              fig('usage-customers', count(u.uniqueCustomers), 'Customers'),
              fig('usage-new', count(u.newCustomers), 'New customers'),
              fig('usage-discount', rupees(u.discountGiven), 'Discount given'),
              fig('usage-paid', rupees(u.customerPaid), 'Customers paid'),
              fig('usage-remaining', u.remainingRedemptions == null ? '—' : count(u.remainingRedemptions!), 'Uses left'),
            ]),
            const SizedBox(height: 6),
            Text(
              'Discount by who pays: Deligro ${rupees(u.discountByFunder.platform)} · vendors ${rupees(u.discountByFunder.vendor)}'
              '${u.cancelledRedemptions > 0 ? ' · ${u.cancelledRedemptions} on cancelled orders' : ''}',
              style: TextStyle(fontSize: 12.5, color: c.muted),
            ),
            if (u.daily.length > 1) ...[const SizedBox(height: 12), _UsageChart(days: u.daily)],
            if (u.byVendor.isNotEmpty) ...[
              const SizedBox(height: 12),
              for (final v in u.byVendor)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Row(children: [
                    Expanded(child: Text(v.vendor.name, style: TextStyle(color: c.ink))),
                    Text('${count(v.redemptions)} uses', style: dataStyle(context, size: 12.5)),
                    const SizedBox(width: 14),
                    SizedBox(width: 80, child: Text(rupees(v.discountGiven), textAlign: TextAlign.right, style: dataStyle(context, size: 12.5))),
                  ]),
                ),
            ],
          ]),
          FormSection(title: 'Change history', children: [
            if (b.changes.isEmpty) Text('No changes recorded.', style: TextStyle(color: c.muted)),
            for (final ch in b.changes) _ChangeRow(change: ch),
          ]),
          const SizedBox(height: 22),
          if (o.allowed.edit)
            OutlinedButton.icon(
              key: const Key('offer-edit'),
              onPressed: _busy ? null : () => _edit(o),
              icon: const Icon(Icons.edit_outlined),
              label: const Text('Edit offer'),
            ),
          if (o.allowed.activate) ...[
            const SizedBox(height: 10),
            FilledButton(key: const Key('offer-activate'), onPressed: _busy ? null : () => _act(true), child: const Text('Activate')),
          ],
          if (o.allowed.deactivate) ...[
            const SizedBox(height: 10),
            OutlinedButton(key: const Key('offer-deactivate'), onPressed: _busy ? null : () => _act(false), child: const Text('Deactivate')),
          ],
        ],
      ),
    );
  }

  Future<void> _pickRange() async {
    final now = DateTime.now().toUtc().add(istOffset);
    final r = await showDateRangePicker(
      context: context,
      firstDate: DateTime(now.year - 1),
      lastDate: DateTime(now.year, now.month, now.day),
    );
    if (r == null) return;
    final f = DateFormat('yyyy-MM-dd');
    setState(() {
      _from = f.format(r.start);
      _to = f.format(r.end);
    });
  }

  Future<void> _edit(OfferDetail o) async {
    final done = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => OfferFormScreen(edit: o)));
    if (done == true && mounted) ref.invalidate(offerDetailProvider(_key));
  }

  Future<void> _act(bool activate) async {
    final reason = await showReasonDialog(
      context,
      title: activate ? 'Activate this offer?' : 'Deactivate this offer?',
      message: activate ? 'Customers can use it again until it expires.' : 'Customers can no longer use it. Orders already placed keep their discount.',
      quickPicks: activate ? const ['Festival extended', 'Vendor asked'] : const ['Vendor asked to stop', 'Budget reached', 'Misuse'],
      submitLabel: activate ? 'Activate' : 'Deactivate',
    );
    if (reason == null || !mounted) return;
    await _send(OfferAction(activate: activate, reason: reason));
  }

  Future<void> _send(OfferAction a) async {
    setState(() => _busy = true);
    final Outcome<OfferDetail> out;
    try {
      out = await ref.read(offerDetailProvider(_key).notifier).act(a);
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (!mounted) return;
      setState(() => _busy = false);
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(e.friendly), action: SnackBarAction(label: 'Retry', onPressed: () => _send(a))));
      return;
    }
    if (!mounted) return;
    setState(() => _busy = false);
    ref.invalidate(offerListProvider);
    switch (out) {
      case Applied():
        showSnack(context, a.activate ? 'Offer activated.' : 'Offer deactivated.');
      case Refused(:final code):
        showSnack(context, offerRefusal(code));
    }
  }
}

class _ChangeRow extends StatelessWidget {
  const _ChangeRow({required this.change});
  final OfferChange change;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final ch = change;
    final who = ch.actor == null ? 'System' : '${ch.actor!.name} (${ch.actor!.role})';
    final what = switch (ch.op) {
      'insert' => ch.target == 'coupon' ? 'Created' : 'Added',
      'delete' => 'Removed',
      _ => 'Changed',
    };
    return Container(
      key: Key('change-${ch.id}'),
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.line))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('$what · $who · ${istText(ch.at)}', style: TextStyle(fontSize: 12.5, color: c.muted)),
        const SizedBox(height: 2),
        for (final f in ch.fields) Text('${offerFieldLabel(f.field)}: ${f.before ?? '—'} → ${f.after ?? '—'}', style: TextStyle(color: c.ink)),
        if (ch.reason != null) Text(ch.reason!, style: TextStyle(color: c.ink, fontStyle: FontStyle.italic)),
      ]),
    );
  }
}

class _UsageChart extends StatelessWidget {
  const _UsageChart({required this.days});
  final List<OfferDay> days;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final maxY = days.fold<int>(0, (m, d) => d.redemptions > m ? d.redemptions : m);
    return SizedBox(
      height: 150,
      child: BarChart(BarChartData(
        maxY: maxY == 0 ? 1 : maxY * 1.2,
        gridData: FlGridData(drawVerticalLine: false, getDrawingHorizontalLine: (_) => FlLine(color: c.line, strokeWidth: 1)),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          topTitles: const AxisTitles(),
          rightTitles: const AxisTitles(),
          leftTitles: AxisTitles(sideTitles: SideTitles(showTitles: true, reservedSize: 32, getTitlesWidget: (v, m) => v == m.max ? const SizedBox.shrink() : Text('${v.round()}', style: TextStyle(fontSize: 10, color: c.muted)))),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              getTitlesWidget: (v, _) {
                final i = v.round();
                final step = (days.length / 4).ceil().clamp(1, 1 << 20);
                if (i < 0 || i >= days.length || i % step != 0) return const SizedBox.shrink();
                final d = DateTime.tryParse(days[i].date);
                return Padding(padding: const EdgeInsets.only(top: 6), child: Text(d == null ? days[i].date : DateFormat('d MMM').format(d), style: TextStyle(fontSize: 10, color: c.muted)));
              },
            ),
          ),
        ),
        barGroups: [
          for (var i = 0; i < days.length; i++)
            BarChartGroupData(x: i, barRods: [BarChartRodData(toY: days[i].redemptions.toDouble(), color: c.accent, width: 10, borderRadius: BorderRadius.circular(3))]),
        ],
      )),
    );
  }
}
