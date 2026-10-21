import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';

/// The shared frame of the gate screens: an icon, a sentence, and the actions
/// that get the rider out of there.
class GateMessage extends StatelessWidget {
  const GateMessage({
    super.key,
    required this.icon,
    required this.message,
    this.detail,
    required this.actions,
  });

  final IconData icon;
  final String message;
  final String? detail;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Container(
                    width: 72,
                    height: 72,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(color: c.accentSoft, shape: BoxShape.circle),
                    child: Icon(icon, size: 34, color: c.accentInk),
                  ),
                  const SizedBox(height: 20),
                  Semantics(
                    liveRegion: true,
                    child: Text(
                      message,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleLarge,
                    ),
                  ),
                  if (detail != null) ...[
                    const SizedBox(height: 8),
                    Text(
                      detail!,
                      textAlign: TextAlign.center,
                      style: TextStyle(color: c.muted, fontSize: 14, height: 1.4),
                    ),
                  ],
                  const SizedBox(height: 24),
                  for (var i = 0; i < actions.length; i++) ...[
                    if (i > 0) const SizedBox(height: 8),
                    actions[i],
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// "Sign out" for a screen with no rider behind it. The router's redirect
/// takes the user to /login once the session is gone.
class GateSignOutButton extends ConsumerWidget {
  const GateSignOutButton({super.key, this.filled = false});

  final bool filled;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final label = tr(ref, 'Sign out', 'साइन आउट करें');
    void onPressed() => ref.read(authRepoProvider).signOut();
    return filled
        ? FilledButton(onPressed: onPressed, child: Text(label))
        : TextButton(
            onPressed: onPressed,
            style: TextButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            child: Text(label),
          );
  }
}

/// "Retry" re-asks `/api/rider/me`.
class GateRetryButton extends ConsumerWidget {
  const GateRetryButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => FilledButton(
        onPressed: () => ref.invalidate(meProvider),
        child: Text(tr(ref, 'Retry', 'फिर कोशिश करें')),
      );
}
