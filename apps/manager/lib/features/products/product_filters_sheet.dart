import 'package:flutter/material.dart';

import '../../models/orders.dart' show VendorRef;
import '../../models/products.dart';

/// Vendor and category filters. The choices come from the server's vendor
/// directory and category list, plus whatever is loaded.
Future<ProductFilters?> showProductFiltersSheet(
  BuildContext context, {
  required ProductFilters current,
  required List<VendorRef> vendors,
  required List<String> categories,
}) =>
    showModalBottomSheet<ProductFilters>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) {
        var vendor = current.vendorId;
        var vendorName = current.vendorName;
        var category = current.category;
        return StatefulBuilder(
          builder: (ctx, setState) => SafeArea(
            child: ConstrainedBox(
              constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(ctx).height * 0.8),
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Filter products', style: Theme.of(ctx).textTheme.titleLarge),
                    const SizedBox(height: 12),
                    Text('Vendor', style: Theme.of(ctx).textTheme.titleSmall),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        ChoiceChip(
                          label: const Text('Any'),
                          selected: vendor == null,
                          onSelected: (_) => setState(() {
                            vendor = null;
                            vendorName = null;
                          }),
                        ),
                        for (final v in vendors)
                          ChoiceChip(
                            label: Text(v.name),
                            selected: vendor == v.id,
                            onSelected: (_) => setState(() {
                              vendor = v.id;
                              vendorName = v.name;
                            }),
                          ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Text('Category', style: Theme.of(ctx).textTheme.titleSmall),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        ChoiceChip(label: const Text('Any'), selected: category == null, onSelected: (_) => setState(() => category = null)),
                        for (final cat in categories)
                          ChoiceChip(label: Text(cat), selected: category == cat, onSelected: (_) => setState(() => category = cat)),
                      ],
                    ),
                    const SizedBox(height: 20),
                    // Wraps rather than overflowing on a narrow phone or a large font.
                    OverflowBar(
                      alignment: MainAxisAlignment.spaceBetween,
                      overflowAlignment: OverflowBarAlignment.end,
                      overflowSpacing: 8,
                      children: [
                        TextButton(
                          onPressed: () => Navigator.pop(ctx, const ProductFilters()),
                          child: const Text('Clear all'),
                        ),
                        FilledButton(
                          onPressed: () => Navigator.pop(
                            ctx,
                            current.copyWith(vendorId: vendor, vendorName: vendorName, category: category),
                          ),
                          child: const Text('Show products'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
