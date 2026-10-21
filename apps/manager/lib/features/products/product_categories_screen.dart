import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../state/products.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';

/// Product categories across the manager's vendors (§12.4): how many dishes,
/// how many unavailable, in how many shops, and which need approval.
class ProductCategoriesScreen extends ConsumerWidget {
  const ProductCategoriesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Categories'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: AsyncView(
        value: ref.watch(productCategoriesProvider),
        onRetry: () => ref.invalidate(productCategoriesProvider),
        builder: (rows) => rows.isEmpty
            ? const EmptyLine('No categories yet.')
            : RefreshIndicator(
                onRefresh: () => ref.refresh(productCategoriesProvider.future),
                child: ListView.separated(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
                  itemCount: rows.length,
                  separatorBuilder: (_, _) => Divider(color: c.line, height: 1),
                  itemBuilder: (context, i) {
                    final r = rows[i];
                    return ListTile(
                      contentPadding: EdgeInsets.zero,
                      title: Row(
                        children: [
                          Flexible(child: Text(r.name, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink))),
                          if (r.restricted) ...[
                            const SizedBox(width: 8),
                            Icon(Icons.lock_outline, size: 15, color: c.deal, semanticLabel: 'Needs approval'),
                          ],
                        ],
                      ),
                      subtitle: Text(
                        '${count(r.itemCount)} dishes · ${count(r.vendorCount)} shops'
                        '${r.unavailableCount > 0 ? ' · ${count(r.unavailableCount)} unavailable' : ''}',
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => GoRouter.maybeOf(context)
                          ?.push(Uri(path: '/more/products', queryParameters: {'category': r.name}).toString()),
                    );
                  },
                ),
              ),
      ),
    );
  }
}
