import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';

/// Placeholder for the rider's home (the availability switch and delivery
/// screens are the next tasks): proves the gate let a rider through.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProvider).value;
    final c = context.colors;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  tr(ref, 'Hello, ${(me?.name ?? '').isEmpty ? 'rider' : me!.name}',
                      'नमस्ते, ${(me?.name ?? '').isEmpty ? 'राइडर' : me!.name}'),
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                if (me?.riderCode != null) ...[
                  const SizedBox(height: 6),
                  Text(me!.riderCode!, style: dataStyle(context, size: 15)),
                ],
                const SizedBox(height: 6),
                Text(tr(ref, 'Rider home is coming soon.', 'राइडर होम जल्द आ रहा है।'),
                    style: TextStyle(color: c.muted)),
                const SizedBox(height: 20),
                OutlinedButton(
                  onPressed: () async {
                    // Offline first so dispatch stops offering, then end the
                    // session. signoutOffline never throws (ruling R11).
                    await ref.read(riderRepoProvider).signoutOffline();
                    await ref.read(authRepoProvider).signOut();
                  },
                  child: Text(tr(ref, 'Sign out', 'साइन आउट करें')),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
