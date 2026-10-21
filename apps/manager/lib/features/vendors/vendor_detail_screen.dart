import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/vendors.dart';
import '../../widgets/async_view.dart';

/// One vendor (§4.3–4.15). Completed in the next task.
class VendorDetailScreen extends StatelessWidget {
  const VendorDetailScreen({super.key, required this.vendorId});
  final String vendorId;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Vendor')),
        body: VendorDetailBody(vendorId: vendorId),
      );
}

class VendorDetailBody extends ConsumerWidget {
  const VendorDetailBody({super.key, required this.vendorId});
  final String vendorId;

  @override
  Widget build(BuildContext context, WidgetRef ref) => KeyedSubtree(
        key: const Key('vendor-detail-body'),
        child: AsyncView(
          value: ref.watch(vendorDetailProvider(vendorId)),
          onRetry: () => ref.invalidate(vendorDetailProvider(vendorId)),
          builder: (v) => Center(child: Text(v.name)),
        ),
      );
}
