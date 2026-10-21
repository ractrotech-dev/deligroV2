import 'package:flutter/material.dart';

import 'gate_widgets.dart';

/// `/api/rider/me` answered 404 (or 503 not_configured): the website the app
/// talks to does not have the rider routes yet. Not the rider's fault and not a
/// crash, so say so and let them retry once the server is updated.
class NeedsUpdateScreen extends StatelessWidget {
  const NeedsUpdateScreen({super.key});

  @override
  Widget build(BuildContext context) => GateMessage(
        icon: Icons.system_update_alt_rounded,
        message: 'Deligro\'s server needs an update — try again later.',
        actions: const [GateRetryButton(), GateSignOutButton()],
      );
}
