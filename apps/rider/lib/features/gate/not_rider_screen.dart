import 'package:flutter/material.dart';

import 'gate_widgets.dart';

/// A signed-in account that is not a delivery partner (`/api/rider/me` → 403
/// `not_rider`). The rider app has nothing to show it; Sign out is the way on.
class NotRiderScreen extends StatelessWidget {
  const NotRiderScreen({super.key});

  @override
  Widget build(BuildContext context) => GateMessage(
        icon: Icons.two_wheeler_rounded,
        message: 'This account isn\'t a Deligro rider. Ask Deligro support to turn on rider access.',
        actions: const [GateSignOutButton(filled: true)],
      );
}
