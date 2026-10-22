import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/customers.dart';
import '../../models/orders.dart' show istOffset;
import '../../state/customers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import '../marketing/form_bits.dart';

/// Repeat orders and retention (§10.6): customers in the range, new and
/// returning, repeat rate, and monthly cohorts — the share whose second order
/// came within 30, 60 and 90 days ("—" until a cohort is that old).
class RetentionScreen extends ConsumerStatefulWidget {
  const RetentionScreen({super.key});

  @override
  ConsumerState<RetentionScreen> createState() => _RetentionScreenState();
}

class _RetentionScreenState extends ConsumerState<RetentionScreen> {
  String? _from;
  String? _to;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final zone = ref.watch(activeZoneProvider);
    final key = (from: _from, to: _to, zoneId: zone?.id);
    final value = ref.watch(retentionProvider(key));
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Retention'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: AsyncView<Retention>(
        value: value,
        onRetry: () => ref.invalidate(retentionProvider(key)),
        builder: (r) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(retentionProvider(key)),
          child: ListView(
            key: const Key('retention'),
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 40),
            children: [
              Row(children: [
                Expanded(child: Text('${istDay(r.from)} – ${istDay(r.to)}', style: TextStyle(color: c.muted))),
                TextButton.icon(key: const Key('retention-range'), onPressed: _pickRange, icon: const Icon(Icons.date_range, size: 18), label: const Text('Range')),
              ]),
              const SizedBox(height: 8),
              Wrap(spacing: 22, runSpacing: 14, children: [
                _fig(context, count(r.summary.customers), 'Customers'),
                _fig(context, count(r.summary.newCustomers), 'New'),
                _fig(context, count(r.summary.returningCustomers), 'Returning'),
                _fig(context, pctOrDash(r.summary.repeatRate), 'Ordered 2+ times'),
                _fig(context, r.summary.ordersPerCustomer == null ? '—' : r.summary.ordersPerCustomer!.toStringAsFixed(1), 'Orders each'),
                _fig(context, rupees(r.summary.aovPerCustomer), 'Average order'),
              ]),
              FormSection(title: 'Cohorts by first order', children: [
                Text('Share of each month\'s new customers who ordered again within…', style: TextStyle(color: c.muted, fontSize: 12.5)),
                const SizedBox(height: 8),
                _row(context, 'Month', 'Customers', '30 days', '60 days', '90 days', header: true),
                for (final k in r.cohorts)
                  _row(context, _month(k.cohort), count(k.customers), pctOrDash(k.r30), pctOrDash(k.r60), pctOrDash(k.r90), cohort: k.cohort),
                if (r.cohorts.isEmpty) Text('No new customers in this range.', style: TextStyle(color: c.muted)),
              ]),
            ],
          ),
        ),
      ),
    );
  }

  static String _month(String ym) {
    final d = DateTime.tryParse('$ym-01');
    return d == null ? ym : DateFormat('MMM y').format(d);
  }

  Widget _fig(BuildContext context, String v, String label) => SizedBox(
        width: 140,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(v, style: dataStyle(context, size: 18, weight: FontWeight.w700)),
          Text(label, style: TextStyle(fontSize: 12, color: context.colors.muted)),
        ]),
      );

  Widget _row(BuildContext context, String a, String b, String r30, String r60, String r90, {bool header = false, String? cohort}) {
    final c = context.colors;
    TextStyle s(bool num) => header
        ? TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c.muted)
        : (num ? dataStyle(context, size: 13) : TextStyle(fontSize: 13.5, color: c.ink));
    Widget cell(String t, String suffix, {int flex = 2, bool num = true}) => Expanded(
          flex: flex,
          child: Text(t, key: cohort == null ? null : Key('cohort-$cohort-$suffix'), textAlign: num ? TextAlign.right : TextAlign.left, style: s(num)),
        );
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.line))),
      child: Row(children: [
        cell(a, 'month', flex: 3, num: false),
        cell(b, 'customers'),
        cell(r30, 'r30'),
        cell(r60, 'r60'),
        cell(r90, 'r90'),
      ]),
    );
  }

  Future<void> _pickRange() async {
    final now = DateTime.now().toUtc().add(istOffset);
    final r = await showDateRangePicker(context: context, firstDate: DateTime(now.year - 3), lastDate: DateTime(now.year, now.month, now.day));
    if (r == null) return;
    final f = DateFormat('yyyy-MM-dd');
    setState(() {
      _from = f.format(r.start);
      _to = f.format(r.end);
    });
  }
}
