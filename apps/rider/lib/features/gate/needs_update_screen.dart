import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n.dart';
import 'gate_widgets.dart';

/// `/api/rider/me` answered 404 (or 503 not_configured): the website the app
/// talks to does not have the rider routes yet. Not the rider's fault and not a
/// crash, so say so and let them retry once the server is updated.
class NeedsUpdateScreen extends ConsumerWidget {
  const NeedsUpdateScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => GateMessage(
        icon: Icons.system_update_alt_rounded,
        message: tr(
          ref,
          'Deligro\'s server needs an update — try again later.',
          'Deligro के सर्वर को अपडेट चाहिए — बाद में फिर कोशिश करें।',
        ),
        actions: const [GateRetryButton(), GateSignOutButton()],
      );
}
