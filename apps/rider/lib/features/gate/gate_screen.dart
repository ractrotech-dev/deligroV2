import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../state/providers.dart';
import 'gate_widgets.dart';

/// Between sign-in and the rider's home: waiting for `/api/rider/me`, or the
/// reason it did not come (no connection, a server error) with Retry. The
/// answers that route elsewhere (403, 404) never land here.
class GateScreen extends ConsumerWidget {
  const GateScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(meProvider);
    final error = me.error;
    if (me.isLoading || error == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final text = error is ApiException ? error.friendly : friendlyFallback;
    return GateMessage(
      icon: Icons.cloud_off_rounded,
      message: text,
      actions: const [GateRetryButton(), GateSignOutButton()],
    );
  }

  static const friendlyFallback = 'Something went wrong. Please try again.';
}
