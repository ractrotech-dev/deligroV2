import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/providers.dart';
import '../../state/session.dart';

/// Signed-in landing until the shell lands (Phase 1 Task 6).
class HomePlaceholder extends ConsumerWidget {
  const HomePlaceholder({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(vendorMeProvider).value;
    return Scaffold(
      body: Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(me?.activeShop.name ?? ''),
          TextButton(onPressed: () => ref.read(authRepoProvider).signOut(), child: const Text('Sign out')),
        ]),
      ),
    );
  }
}
