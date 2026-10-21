import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n.dart';
import 'gate_widgets.dart';

/// A signed-in account that is not a delivery partner (`/api/rider/me` → 403
/// `not_rider`). The rider app has nothing to show it; Sign out is the way on.
class NotRiderScreen extends ConsumerWidget {
  const NotRiderScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => GateMessage(
        icon: Icons.two_wheeler_rounded,
        message: tr(
          ref,
          'This account isn\'t a Deligro rider. Ask Deligro ops to enable rider access.',
          'यह खाता Deligro राइडर का नहीं है। राइडर एक्सेस चालू कराने के लिए Deligro ऑप्स से कहें।',
        ),
        actions: const [GateSignOutButton(filled: true)],
      );
}
