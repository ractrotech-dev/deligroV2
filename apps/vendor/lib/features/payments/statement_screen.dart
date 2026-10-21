import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/documents.dart';
import '../../core/export.dart';
import '../../core/format.dart';
import '../../models/money.dart';
import '../../state/money.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';
import '../documents/document_screen.dart';

/// One settlement: how the payout was worked out, every order in it, and the
/// statement as PDF / CSV / Excel to keep or send to an accountant.
class StatementScreen extends ConsumerWidget {
  const StatementScreen({super.key, required this.settlementId});

  final String settlementId;

  static ExportTable table(Statement s) => ExportTable(
    title: 'Settlement ${s.periodLabel}',
    headers: const [
      'Order',
      'Delivered',
      'Payment',
      'Sale',
      'Deligro discount',
      'Commission',
      'GST on commission',
      'Other charges',
      'Refund recovered',
      'Earnings',
      'To payout',
    ],
    rows: [
      for (final l in s.lines)
        [
          l.code,
          l.deliveredAt == null ? '' : DateFormat('yyyy-MM-dd HH:mm').format(l.deliveredAt!),
          l.paymentMethod == 'online' ? 'Online' : 'Cash',
          l.sale,
          l.platformDiscount,
          l.commission,
          l.commissionGst,
          l.otherCharges,
          l.refundRecovered,
          l.earnings,
          l.contribution,
        ],
    ],
  );

  Future<void> _export(BuildContext context, WidgetRef ref, Statement s, String kind) async {
    final name = 'deligro-settlement-${fileSlug(s.periodLabel)}';
    await runWrite(context, ref, () async {
      switch (kind) {
        case 'csv':
          await shareBytes(toCsv(table(s)), '$name.csv', csvMime);
        case 'xlsx':
          await shareBytes(toXlsx(table(s)), '$name.xlsx', xlsxMime);
      }
    });
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(statementProvider(settlementId));
    final s = async.value;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Statement'),
        actions: [
          if (s != null)
            PopupMenuButton<String>(
              icon: const Icon(Icons.ios_share_rounded),
              tooltip: 'Download',
              onSelected: (v) => v == 'pdf'
                  ? context.push(
                      '/document',
                      extra: DocumentRequest(
                        title: 'Settlement ${s.periodLabel}',
                        fileName: 'deligro-settlement-${fileSlug(s.periodLabel)}.pdf',
                        build: () async => statementPdf(s, await DocFonts.load()),
                      ),
                    )
                  : _export(context, ref, s, v),
              itemBuilder: (_) => const [
                PopupMenuItem(value: 'pdf', child: Text('PDF (view, print, share)')),
                PopupMenuItem(value: 'xlsx', child: Text('Excel')),
                PopupMenuItem(value: 'csv', child: Text('CSV')),
              ],
            ),
        ],
      ),
      body: switch (async) {
        AsyncData(:final value) => _Body(s: value),
        AsyncError(:final error) => LoadFailed(
          error: error,
          onRetry: () => ref.invalidate(statementProvider(settlementId)),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.s});

  final Statement s;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget row(String k, int v, {bool bold = false, bool minus = false}) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          Expanded(
            child: Text(k, style: TextStyle(fontWeight: bold ? FontWeight.w800 : FontWeight.w500)),
          ),
          Text(
            minus && v != 0 ? '− ${rupees(v)}' : rupees(v),
            style: dataStyle(context, size: bold ? 17 : 14, weight: bold ? FontWeight.w800 : FontWeight.w600),
          ),
        ],
      ),
    );
    final pct = s.commissionPct % 1 == 0 ? s.commissionPct.toStringAsFixed(0) : s.commissionPct.toStringAsFixed(1);
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(s.periodLabel, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              Text(
                [
                  s.status == 'void'
                      ? 'Voided by Deligro'
                      : 'Paid ${s.paidAt == null ? '' : DateFormat('d MMM y', 'en_IN').format(s.paidAt!)}',
                  if (s.paymentRef != null) 'Ref ${s.paymentRef}',
                  ?s.paidTo,
                ].join(' · '),
                style: TextStyle(color: s.status == 'void' ? c.deal : c.muted),
              ),
            ],
          ),
        ),
        Panel(
          child: Column(
            children: [
              row('Food sales', s.foodGross),
              row('Commission ($pct%)', s.commission, minus: true),
              row('GST on commission', s.commissionGst, minus: true),
              if (s.otherCharges > 0) row('Other charges', s.otherCharges, minus: true),
              if (s.refundsRecovered > 0) row('Refunds recovered', s.refundsRecovered, minus: true),
              const Divider(height: 20),
              row('Net payable', s.netPayable, bold: true),
            ],
          ),
        ),
        SectionHeading('${s.lines.length} orders'),
        for (final l in s.lines)
          ListTile(
            dense: true,
            contentPadding: const EdgeInsets.symmetric(horizontal: 20),
            title: Text(l.code, style: dataStyle(context, size: 14, weight: FontWeight.w800)),
            subtitle: Text(
              '${l.deliveredAt == null ? '' : DateFormat('d MMM, h:mm a', 'en_IN').format(l.deliveredAt!)} · ${l.paymentMethod == 'online' ? 'Online' : 'Cash'} · sale ${rupees(l.sale)}',
              style: TextStyle(color: c.muted, fontSize: 12.5),
            ),
            trailing: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(rupees(l.earnings), style: dataStyle(context, size: 14, weight: FontWeight.w800)),
                Text('charges ${rupees(l.charges)}', style: TextStyle(color: c.muted, fontSize: 11.5)),
              ],
            ),
          ),
      ],
    );
  }
}
