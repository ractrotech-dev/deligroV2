import 'package:flutter/material.dart';

import '../../models/vendors.dart';

/// Category filter for the Vendors list. The categories offered are the ones
/// on the vendors already loaded (the zone comes from the zone picker).
Future<VendorFilters?> showVendorFiltersSheet(
  BuildContext context, {
  required VendorFilters current,
  required List<String> categories,
}) =>
    showModalBottomSheet<VendorFilters>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) {
        var picked = current.category;
        return StatefulBuilder(
          builder: (ctx, setState) => SafeArea(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Filter vendors', style: Theme.of(ctx).textTheme.titleLarge),
                  const SizedBox(height: 12),
                  Text('Category', style: Theme.of(ctx).textTheme.titleSmall),
                  const SizedBox(height: 8),
                  if (categories.isEmpty)
                    const Text('No categories among the vendors loaded yet.')
                  else
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        ChoiceChip(label: const Text('Any'), selected: picked == null, onSelected: (_) => setState(() => picked = null)),
                        for (final cat in categories)
                          ChoiceChip(
                            key: Key('vendor-category-$cat'),
                            label: Text(cat),
                            selected: picked == cat,
                            onSelected: (_) => setState(() => picked = cat),
                          ),
                      ],
                    ),
                  const SizedBox(height: 20),
                  Row(
                    children: [
                      TextButton(
                        onPressed: () => Navigator.pop(ctx, current.copyWith(category: null, filter: null, statuses: const {})),
                        child: const Text('Clear all'),
                      ),
                      const Spacer(),
                      FilledButton(
                        key: const Key('vendor-filters-apply'),
                        onPressed: () => Navigator.pop(ctx, current.copyWith(category: picked)),
                        child: const Text('Show vendors'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
