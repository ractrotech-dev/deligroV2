import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../theme/app_theme.dart';

/// A screen whose build phase has not landed yet. Says which phase delivers
/// it, so a test build never passes off an empty screen as finished.
class PhasePlaceholder extends ConsumerWidget {
  const PhasePlaceholder({
    super.key,
    required this.title,
    required this.icon,
    required this.phase,
    this.what,
    this.showAppBar = true,
  });

  final String title;
  final IconData icon;
  final int phase;
  final String? what;
  final bool showAppBar;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final body = Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(radiusBlock)),
              child: Icon(icon, color: c.accentInk, size: 30),
            ),
            const SizedBox(height: 16),
            Text(title, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800, color: c.ink)),
            const SizedBox(height: 6),
            Text(
              'Arrives in build phase $phase.',
              key: const Key('phase-label'),
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.accentInk),
            ),
            if (what != null) ...[
              const SizedBox(height: 6),
              Text(what!, textAlign: TextAlign.center, style: TextStyle(fontSize: 13.5, color: c.muted, height: 1.4)),
            ],
          ],
        ),
      ),
    );
    if (!showAppBar) return body;
    return Scaffold(appBar: AppBar(title: Text(title)), body: body);
  }
}
