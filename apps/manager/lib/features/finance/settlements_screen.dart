import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/settlement.dart';
import '../../state/finance.dart';
import '../../theme/app_theme.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import 'finance_list.dart';
import 'settlement_detail_screen.dart';

const settlementsWideBreakpoint = 840.0;

Color settlementStatusColor(AppColors c, SettlementSummary s) => s.awaitingApproval
    ? c.amberText
    : switch (s.status) {
        SettlementStatus.paid => c.green,
        SettlementStatus.draft => c.blue,
        SettlementStatus.voided || SettlementStatus.unknown => c.muted,
      };

/// Settlement history (§7 tracking 6–7): every settlement with its period,
/// net and the transaction reference in full. List and detail side by side
/// from 840 dp.
class SettlementsScreen extends ConsumerStatefulWidget {
  const SettlementsScreen({super.key, this.query});

  /// `?status=paid` (from the overview's "Vendor payments completed").
  final Uri? query;

  @override
  ConsumerState<SettlementsScreen> createState() => _SettlementsScreenState();
}

class _SettlementsScreenState extends ConsumerState<SettlementsScreen> {
  late SettlementFilter _status = SettlementFilter.values.firstWhere(
    (f) => f.wire != null && f.wire == widget.query?.queryParameters['status'],
    orElse: () => SettlementFilter.all,
  );
  String? _selected;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final f = SettlementFilters(status: _status, zoneId: ref.watch(activeZoneProvider)?.id);
    final value = ref.watch(settlementsProvider(f));
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Settlement history'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: LayoutBuilder(builder: (context, box) {
        final wide = box.maxWidth >= settlementsWideBreakpoint;
        final list = FinancePagedList(
          value: value,
          onRetry: () => ref.invalidate(settlementsProvider(f)),
          onRefresh: () => ref.read(settlementsProvider(f).notifier).refresh(),
          onLoadMore: () => ref.read(settlementsProvider(f).notifier).loadMore(),
          emptyText: 'No settlements here.',
          header: (data) => [
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
              child: Row(children: [
                for (final s in SettlementFilter.values)
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      key: Key('settlement-filter-${s.name}'),
                      label: Text(s.label),
                      selected: _status == s,
                      onSelected: (_) => setState(() => _status = s),
                    ),
                  ),
              ]),
            ),
            if (data != null)
              TotalsLine(text: '${count(data.counts.count)} settlements · ${rupees(data.counts.payable)} net'),
          ],
          itemBuilder: (context, s) => SettlementRow(
            settlement: s,
            selected: wide && s.id == _selected,
            onTap: () => wide ? setState(() => _selected = s.id) : context.push('/finance/settlements/${s.id}'),
          ),
        );
        if (!wide || _selected == null) return list;
        return Row(children: [
          SizedBox(width: 420, child: list),
          VerticalDivider(width: 1, color: c.line),
          Expanded(child: SettlementDetailBody(settlementId: _selected!)),
        ]);
      }),
    );
  }
}

class SettlementRow extends StatelessWidget {
  const SettlementRow({super.key, required this.settlement, required this.onTap, this.selected = false});
  final SettlementSummary settlement;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = settlement;
    final period = s.periodStart == s.periodEnd ? '${s.periodStart}' : '${s.periodStart} to ${s.periodEnd}';
    return FinanceRow(
      selected: selected,
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Expanded(child: Text(s.vendor.name, style: TextStyle(fontWeight: FontWeight.w800, color: c.ink, fontSize: 15))),
            Text(rupeesSigned(s.netPayable), style: dataStyle(context, size: 16, weight: FontWeight.w800)),
          ]),
          const SizedBox(height: 3),
          Text(
            [
              s.kind == SettlementKind.instant ? 'One order' : period,
              '${count(s.orders)} orders',
              if (s.zone != null) s.zone!.name,
            ].join(' · '),
            style: TextStyle(fontSize: 12.5, color: c.muted),
          ),
          const SizedBox(height: 3),
          StatusText(s.statusLabel, color: settlementStatusColor(c, s)),
          if (s.paymentRef != null) ReferenceText(s.paymentRef!, copyKey: Key('copy-ref-${s.id}')),
          if (s.paidAt != null)
            Text('Paid ${placedAt(s.paidAt)}${s.paidBy == null ? '' : ' by ${s.paidBy!.name}'}',
                style: TextStyle(fontSize: 12.5, color: c.muted)),
        ],
      ),
    );
  }
}
