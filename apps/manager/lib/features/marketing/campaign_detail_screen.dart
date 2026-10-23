import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/marketing.dart';
import '../../models/orders.dart' show istOffset;
import '../../models/outcome.dart';
import '../../state/marketing.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../orders/order_labels.dart' show StatusText;
import '../orders/reason_dialog.dart';
import '../vendors/vendor_tabs.dart' show Figure;
import 'campaign_fields.dart' show BannerPreview;
import 'campaign_form_screen.dart';
import 'form_bits.dart';
import 'marketing_labels.dart';

/// One campaign: its window, funding and links, how it is doing (§8.10–8.11)
/// over a range, and Edit / Cancel / End now.
class CampaignDetailScreen extends ConsumerStatefulWidget {
  const CampaignDetailScreen({super.key, required this.campaignId});
  final String campaignId;

  @override
  ConsumerState<CampaignDetailScreen> createState() => _CampaignDetailScreenState();
}

class _CampaignDetailScreenState extends ConsumerState<CampaignDetailScreen> {
  String? _from;
  String? _to;
  bool _busy = false;

  CampaignKey get _key => (id: widget.campaignId, from: _from, to: _to);

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final value = ref.watch(campaignDetailProvider(_key));
    final title = value.value?.campaign.title;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(title ?? 'Campaign'), backgroundColor: c.bg),
      body: AsyncView<CampaignBundle>(
        value: value,
        onRetry: () => ref.invalidate(campaignDetailProvider(_key)),
        builder: (b) => _body(context, b),
      ),
    );
  }

  Widget _body(BuildContext context, CampaignBundle b) {
    final c = context.colors;
    final x = b.campaign;
    final p = b.performance;
    Widget fact(String label, String value) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 5),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SizedBox(width: 120, child: Text(label, style: TextStyle(color: c.muted, fontSize: 13.5))),
            Expanded(child: Text(value, style: TextStyle(color: c.ink, fontSize: 14))),
          ]),
        );

    return RefreshIndicator(
      onRefresh: () => ref.read(campaignDetailProvider(_key).notifier).refresh(),
      child: ListView(
        key: const Key('campaign-detail'),
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 40),
        children: [
          Row(children: [
            Icon(campaignIcon(x.kind), color: c.accent),
            const SizedBox(width: 8),
            Expanded(child: Text(x.kind.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: c.muted))),
            const SizedBox(width: 8),
            StatusText(campaignStateLabel(x), color: campaignStateColor(c, x.state, x.status), size: 13.5),
          ]),
          const SizedBox(height: 10),
          fact('Window', '${istText(x.startsAt)} – ${istText(x.endsAt)}'),
          fact('Zone', x.zone.name),
          if (x.vendors.isNotEmpty) fact(x.vendors.length == 1 ? 'Shop' : 'Shops', x.vendors.map((v) => v.name).join(', ')),
          if (x.slotPosition != null) fact('Slot', 'Position ${x.slotPosition} on the home feed'),
          if (x.items.isNotEmpty) fact('Dishes', x.items.map((i) => i.name).join(', ')),
          fact('Budget', x.budget == null ? 'Not set' : '${rupees(x.budget!)} (recorded)'),
          fact('Funded by', x.fundingLabel),
          if (x.createdBy != null) fact('Created by', '${x.createdBy!.name}, ${istText(x.createdAt)}'),
          if (x.cancelledReason != null) fact('Cancelled', x.cancelledReason!),
          if (x.notes != null) fact('Notes', x.notes!),
          if (x.offerCode != null)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.local_offer_outlined, color: c.accent),
              title: Text('Offer ${x.offerCode}'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => GoRouter.maybeOf(context)?.push('/more/offers/${x.offerCode}'),
            ),
          if (x.requestId != null)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.inbox_outlined, color: c.accent),
              title: const Text("The vendor's request"),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => GoRouter.maybeOf(context)?.push('/more/marketing/requests/${x.requestId}'),
            ),
          if (x.banner != null) ...[const SizedBox(height: 10), BannerPreview(banner: x.banner!)],
          FormSection(title: 'Performance', children: [
            Row(children: [
              Expanded(
                child: Text(
                  p.from == null ? 'Over the campaign so far' : '${istDay(p.from)} – ${istDay(p.to)}',
                  style: TextStyle(color: c.muted, fontSize: 13),
                ),
              ),
              TextButton.icon(
                key: const Key('perf-range'),
                onPressed: () => _pickRange(x),
                icon: const Icon(Icons.date_range, size: 18),
                label: const Text('Range'),
              ),
            ]),
            const SizedBox(height: 6),
            Wrap(spacing: 22, runSpacing: 14, children: [
              _fig('perf-impressions', count(p.impressions), 'Views'),
              _fig('perf-clicks', count(p.clicks), 'Taps'),
              _fig('perf-ctr', p.ctrLabel, 'Tap rate'),
              _fig('perf-redemptions', count(p.redemptions), 'Offer uses'),
              _fig('perf-discount', rupees(p.discountGiven), 'Discount given'),
              _fig('perf-orders', count(p.attributedOrders), 'Attributed orders'),
              _fig('perf-sales', rupees(p.attributedSales), 'Attributed sales'),
              _fig('perf-customers', count(p.attributedCustomers), 'Customers'),
            ]),
            const SizedBox(height: 6),
            Text(
              'Attributed: the order used the campaign\'s code, or the customer tapped the campaign within 24 hours before ordering.',
              style: TextStyle(fontSize: 12, color: c.muted),
            ),
            if (p.comparison != null) ...[
              const SizedBox(height: 14),
              _Comparison(key: const Key('perf-comparison'), c: p.comparison!),
            ],
            if (p.daily.length > 1) ...[
              const SizedBox(height: 14),
              _DailyChart(days: p.daily),
            ],
          ]),
          const SizedBox(height: 22),
          if (x.allowed.edit)
            OutlinedButton.icon(
              key: const Key('campaign-edit'),
              onPressed: _busy ? null : () => _edit(x),
              icon: const Icon(Icons.edit_outlined),
              label: Text(x.allowed.editWindowOnly ? 'Change end, budget or banner' : 'Edit campaign'),
            ),
          if (x.allowed.cancel) ...[
            const SizedBox(height: 10),
            OutlinedButton(
              key: const Key('campaign-cancel'),
              onPressed: _busy ? null : () => _act(x, endNow: false),
              child: const Text('Cancel campaign'),
            ),
          ],
          if (x.allowed.endNow) ...[
            const SizedBox(height: 10),
            OutlinedButton(
              key: const Key('campaign-end-now'),
              onPressed: _busy ? null : () => _act(x, endNow: true),
              child: const Text('End now'),
            ),
          ],
        ],
      ),
    );
  }

  Widget _fig(String key, String value, String label) => SizedBox(
        width: 140,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(value, key: Key(key), style: dataStyle(context, size: 17, weight: FontWeight.w700)),
          const SizedBox(height: 2),
          Text(label, style: TextStyle(fontSize: 12, color: context.colors.muted)),
        ]),
      );

  Future<void> _pickRange(CampaignDetail x) async {
    final now = DateTime.now().toUtc().add(istOffset);
    final start = x.startsAt?.toUtc().add(istOffset) ?? now.subtract(const Duration(days: 30));
    final r = await showDateRangePicker(
      context: context,
      firstDate: DateTime(start.year, start.month, start.day),
      lastDate: DateTime(now.year, now.month, now.day),
    );
    if (r == null) return;
    final f = DateFormat('yyyy-MM-dd');
    setState(() {
      _from = f.format(r.start);
      _to = f.format(r.end);
    });
  }

  Future<void> _edit(CampaignDetail x) async {
    final done = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => CampaignFormScreen(edit: x)));
    if (done == true && mounted) ref.invalidate(campaignDetailProvider(_key));
  }

  Future<void> _act(CampaignDetail x, {required bool endNow}) async {
    final reason = await showReasonDialog(
      context,
      title: endNow ? 'End this campaign now?' : 'Cancel this campaign?',
      message: endNow
          ? 'It stops showing at once. Its banner is archived.'
          : "It won't start. A request it came from is marked rejected with your reason.",
      quickPicks: endNow ? const ['Budget used up', 'Vendor asked to stop', 'Shop closed'] : const ['Vendor withdrew', 'Dates changed', 'Duplicate'],
      submitLabel: endNow ? 'End now' : 'Cancel campaign',
    );
    if (reason == null || !mounted) return;
    await _send(CampaignAction(endNow: endNow, reason: reason));
  }

  Future<void> _send(CampaignAction a) async {
    setState(() => _busy = true);
    final Outcome<CampaignDetail> out;
    try {
      out = await ref.read(marketingRepoProvider).actOnCampaign(widget.campaignId, a);
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
    switch (out) {
      case Applied(:final value):
        ref.invalidate(campaignListProvider);
        if (value != null) {
          ref.read(campaignDetailProvider(_key).notifier).adopt(value);
        } else {
          await ref.read(campaignDetailProvider(_key).notifier).refresh();
        }
        if (mounted) showSnack(context, a.endNow ? 'Campaign ended.' : 'Campaign cancelled.');
      case Refused(:final code, :final extra):
        await ref.read(campaignDetailProvider(_key).notifier).refresh();
        if (mounted) showSnack(context, marketingRefusal(code, extra));
    }
  }
}

class _Comparison extends StatelessWidget {
  const _Comparison({super.key, required this.c});
  final CampaignComparison c;

  @override
  Widget build(BuildContext context) {
    final col = context.colors;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: col.surface, borderRadius: BorderRadius.circular(radiusBlock), border: Border.all(color: col.line)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text("The shop's orders: before and during", style: TextStyle(fontWeight: FontWeight.w700, color: col.ink)),
        Text('Same-length period before the campaign. A comparison, not attribution.', style: TextStyle(fontSize: 12, color: col.muted)),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(child: Figure('${c.beforeOrders} · ${rupees(c.beforeSales)}', 'Before')),
          Expanded(child: Figure('${c.duringOrders} · ${rupees(c.duringSales)}', 'During')),
        ]),
      ]),
    );
  }
}

/// Attributed sales and taps per day.
class _DailyChart extends StatelessWidget {
  const _DailyChart({required this.days});
  final List<CampaignDay> days;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final maxSales = days.fold<int>(0, (m, d) => d.attributedSales > m ? d.attributedSales : m);
    final step = (days.length / 4).ceil().clamp(1, 1 << 20);
    return SizedBox(
      height: 170,
      child: LineChart(LineChartData(
        minY: 0,
        maxY: maxSales == 0 ? 1 : maxSales * 1.15,
        gridData: FlGridData(drawVerticalLine: false, getDrawingHorizontalLine: (_) => FlLine(color: c.line, strokeWidth: 1)),
        borderData: FlBorderData(show: false),
        titlesData: FlTitlesData(
          topTitles: const AxisTitles(),
          rightTitles: const AxisTitles(),
          leftTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 52,
              getTitlesWidget: (v, meta) => v == meta.max ? const SizedBox.shrink() : Text(rupees(v), style: TextStyle(fontSize: 10, color: c.muted)),
            ),
          ),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              interval: 1,
              getTitlesWidget: (v, _) {
                final i = v.round();
                if (i < 0 || i >= days.length || i % step != 0) return const SizedBox.shrink();
                final d = DateTime.tryParse(days[i].date);
                return Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Text(d == null ? days[i].date : DateFormat('d MMM').format(d), style: TextStyle(fontSize: 10, color: c.muted)),
                );
              },
            ),
          ),
        ),
        lineBarsData: [
          LineChartBarData(
            spots: [for (var i = 0; i < days.length; i++) FlSpot(i.toDouble(), days[i].attributedSales.toDouble())],
            color: c.accent,
            barWidth: 2.5,
            dotData: FlDotData(show: days.length <= 2),
          ),
        ],
      )),
    );
  }
}
