import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';

/// Between sign-in and the app: loading the vendor record, or the fault that
/// stopped it (no network, server down) with Retry and Sign out.
class BootScreen extends ConsumerWidget {
  const BootScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(vendorMeProvider);
    final c = context.colors;
    final error = me.hasError && !me.isLoading ? me.error : null;

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: error == null
                ? CircularProgressIndicator(color: c.accent)
                : Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.cloud_off_rounded, size: 44, color: c.muted),
                      const SizedBox(height: 14),
                      Text(
                        'We couldn\'t load your shop',
                        textAlign: TextAlign.center,
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        error is ApiException ? error.friendly() : 'Check your internet and try again.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: c.muted),
                      ),
                      const SizedBox(height: 20),
                      FilledButton(onPressed: () => ref.read(vendorMeProvider.notifier).reload(), child: Text('Retry')),
                      TextButton(onPressed: () => ref.read(authRepoProvider).signOut(), child: Text('Sign out')),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}
