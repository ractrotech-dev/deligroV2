import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/order.dart';
import '../../state/orders.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';
import 'order_documents.dart';

/// Invoices & receipts (requirements §11): every completed order with its
/// invoice number; tap to view, print or share the invoice or receipt.
class InvoicesScreen extends ConsumerStatefulWidget {
  const InvoicesScreen({super.key});

  @override
  ConsumerState<InvoicesScreen> createState() => _InvoicesScreenState();
}

class _InvoicesScreenState extends ConsumerState<InvoicesScreen> {
  String _range = 'this_month';
  String? _search;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final ArchiveQuery q = (kind: 'completed', range: _range, date: null, search: _search ?? '');
    final async = ref.watch(archiveProvider(q));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Invoices & receipts'),
        actions: [
          // Daily or date-range transaction statements (requirements §11.5)
          // are the sales report's downloads.
          TextButton.icon(
            onPressed: () => context.go('/reports?tab=report'),
            icon: const Icon(Icons.summarize_outlined, size: 18),
            label: const Text('Statement'),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: TextField(
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search_rounded),
                hintText: 'Search order ID or customer',
              ),
              textInputAction: TextInputAction.search,
              onSubmitted: (v) => setState(() => _search = v.trim().isEmpty ? null : v.trim()),
            ),
          ),
          SizedBox(
            height: 48,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              children: [
                for (final (v, label) in const [
                  ('this_month', 'This month'),
                  ('previous_month', 'Last month'),
                  ('all', 'All'),
                ])
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: ChoiceChip(
                      label: Text(label),
                      selected: _range == v,
                      onSelected: (_) => setState(() => _range = v),
                    ),
                  ),
              ],
            ),
          ),
          Expanded(
            child: switch (async) {
              AsyncData(:final value) when value.orders.isEmpty => Center(
                child: Text('No completed orders here yet.', style: TextStyle(color: c.muted)),
              ),
              AsyncData(:final value) => RefreshIndicator(
                onRefresh: () => ref.refresh(archiveProvider(q).future),
                child: ListView.separated(
                  padding: const EdgeInsets.only(bottom: 24),
                  itemCount: value.orders.length + (value.orders.length < value.total ? 1 : 0),
                  separatorBuilder: (_, _) => Divider(height: 1, color: c.line, indent: 20, endIndent: 20),
                  itemBuilder: (_, i) => i < value.orders.length
                      ? _InvoiceTile(order: value.orders[i])
                      : Padding(
                          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                          child: OutlinedButton(
                            onPressed: () =>
                                runWrite(context, ref, () => ref.read(archiveProvider(q).notifier).loadMore()),
                            child: Text('Show more (${value.total - value.orders.length} older)'),
                          ),
                        ),
                ),
              ),
              AsyncError(:final error) => LoadFailed(error: error, onRetry: () => ref.invalidate(archiveProvider(q))),
              _ => const Center(child: CircularProgressIndicator()),
            },
          ),
        ],
      ),
    );
  }
}

class _InvoiceTile extends ConsumerWidget {
  const _InvoiceTile({required this.order});

  final VendorOrder order;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final o = order;
    return ListTile(
      contentPadding: const EdgeInsets.fromLTRB(20, 4, 8, 4),
      onTap: () => context.push('/orders/${o.id}'),
      title: Text(o.invoiceNo ?? 'No invoice number yet', style: dataStyle(context, size: 14, weight: FontWeight.w800)),
      subtitle: Text(
        '${o.code} · ${o.customerName} · ${placedAt(o.createdAt)}',
        style: TextStyle(color: c.muted, fontSize: 12.5),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(rupees(o.total), style: dataStyle(context, size: 14, weight: FontWeight.w700)),
          IconButton(
            tooltip: 'Invoice',
            onPressed: o.invoiceNo == null ? null : () => openOrderDocument(context, ref, o, OrderDocument.invoice),
            icon: const Icon(Icons.description_outlined),
          ),
          IconButton(
            tooltip: 'Receipt',
            onPressed: () => openOrderDocument(context, ref, o, OrderDocument.receipt),
            icon: const Icon(Icons.receipt_outlined),
          ),
        ],
      ),
    );
  }
}
