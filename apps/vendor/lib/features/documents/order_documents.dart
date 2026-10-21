import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/documents.dart';
import '../../core/export.dart';
import '../../models/order.dart';
import '../../state/money.dart';
import '../../widgets/form_bits.dart';
import 'document_screen.dart';

enum OrderDocument { invoice, receipt }

/// Opens an order's invoice or receipt (requirements §11) to view, print or share.
Future<void> openOrderDocument(BuildContext context, WidgetRef ref, VendorOrder o, OrderDocument kind) async {
  final router = GoRouter.of(context);
  final profile = await runWriteValue(context, ref, () => ref.read(invoiceProfileProvider.future));
  if (profile == null) return;
  final invoice = kind == OrderDocument.invoice;
  final id = fileSlug(invoice ? (o.invoiceNo ?? o.code) : o.code);
  await router.push(
    '/document',
    extra: DocumentRequest(
      title: invoice ? 'Invoice ${o.invoiceNo ?? ''}' : 'Receipt ${o.code}',
      fileName: '${invoice ? 'invoice' : 'receipt'}-$id.pdf',
      build: () async {
        final fonts = await DocFonts.load();
        return invoice ? invoicePdf(o, profile, fonts) : receiptPdf(o, profile, fonts);
      },
    ),
  );
}

/// The app-bar buttons on an order: help with it (a support ticket linked to
/// the order), and Receipt (once accepted) / Invoice (once it has its number).
class OrderDocumentsButton extends ConsumerWidget {
  const OrderDocumentsButton({super.key, required this.order});

  final VendorOrder order;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final help = IconButton(
      tooltip: 'Get help with this order',
      onPressed: () => context.push(
        Uri(path: '/more/support/new', queryParameters: {'order': order.id, 'code': order.code}).toString(),
      ),
      icon: const Icon(Icons.support_agent_outlined),
    );
    if (order.stage == OrderStage.cancelled || order.stage == OrderStage.newOrder) return help;
    final docs = PopupMenuButton<OrderDocument>(
      icon: const Icon(Icons.receipt_long_outlined),
      tooltip: 'Invoice & receipt',
      onSelected: (k) => openOrderDocument(context, ref, order, k),
      itemBuilder: (_) => [
        PopupMenuItem(
          value: OrderDocument.invoice,
          enabled: order.invoiceNo != null,
          child: Text(order.invoiceNo == null ? 'Invoice (once completed)' : 'Invoice ${order.invoiceNo}'),
        ),
        const PopupMenuItem(value: OrderDocument.receipt, child: Text('Receipt (thermal printer)')),
      ],
    );
    return Row(mainAxisSize: MainAxisSize.min, children: [help, docs]);
  }
}
