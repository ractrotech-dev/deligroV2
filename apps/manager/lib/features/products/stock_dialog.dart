import 'package:flutter/material.dart';

import '../../models/products.dart';

/// Set a dish's stock (§12, `products.adjust_stock`): a new absolute number,
/// or stop tracking it. Stock is the vendor's to run; this is the exception,
/// so a reason is required and recorded.
Future<AdjustStock?> showStockDialog(BuildContext context, ProductListItem product) => showDialog<AdjustStock>(
      context: context,
      builder: (_) => _StockDialog(product: product),
    );

class _StockDialog extends StatefulWidget {
  const _StockDialog({required this.product});
  final ProductListItem product;

  @override
  State<_StockDialog> createState() => _StockDialogState();
}

class _StockDialogState extends State<_StockDialog> {
  late final _qty = TextEditingController(text: widget.product.stockQty?.toString() ?? '');
  final _reason = TextEditingController();
  bool _stop = false;

  @override
  void dispose() {
    _qty.dispose();
    _reason.dispose();
    super.dispose();
  }

  int? get _parsed => int.tryParse(_qty.text.trim());

  String? get _qtyError {
    if (_stop || _qty.text.trim().isEmpty) return null;
    final n = _parsed;
    if (n == null || n < 0) return 'Enter 0 or more';
    if (n > 100000) return 'That is more than any shop holds';
    return null;
  }

  bool get _ok => _reason.text.trim().length >= 3 && (_stop || (_parsed != null && _qtyError == null));

  @override
  Widget build(BuildContext context) {
    final p = widget.product;
    return AlertDialog(
      title: Text('Stock for ${p.name}'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Now: ${p.stockWords}'),
            const SizedBox(height: 12),
            TextField(
              key: const Key('stock-qty'),
              controller: _qty,
              enabled: !_stop,
              keyboardType: const TextInputType.numberWithOptions(signed: true),
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: 'New quantity',
                errorText: _qtyError,
                border: const OutlineInputBorder(),
              ),
            ),
            CheckboxListTile(
              key: const Key('stock-stop-tracking'),
              contentPadding: EdgeInsets.zero,
              value: _stop,
              onChanged: (v) => setState(() => _stop = v ?? false),
              title: const Text('Stop tracking stock'),
              subtitle: const Text('The dish is then never sold out by count.'),
            ),
            TextField(
              key: const Key('stock-reason'),
              controller: _reason,
              minLines: 2,
              maxLines: 3,
              maxLength: 300,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(
                labelText: 'Reason',
                helperText: 'At least 3 characters; recorded in the audit log',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Back')),
        FilledButton(
          key: const Key('stock-save'),
          onPressed: _ok
              ? () => Navigator.pop(context, AdjustStock(stockQty: _stop ? null : _parsed, reason: _reason.text.trim()))
              : null,
          child: const Text('Save'),
        ),
      ],
    );
  }
}
