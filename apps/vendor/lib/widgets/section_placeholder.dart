import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../theme/app_theme.dart';

/// A section whose phase hasn't landed yet. Removed as each phase lands; no
/// release build ships with one.
class SectionPlaceholder extends ConsumerWidget {
  const SectionPlaceholder({super.key, required this.title, required this.icon, this.showAppBar = true});

  final String title;
  final IconData icon;
  final bool showAppBar;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final body = Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 44, color: c.muted),
            const SizedBox(height: 12),
            Text(title, style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center),
            const SizedBox(height: 6),
            Text(
              'Coming in the next update.',
              style: TextStyle(color: c.muted),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
    return showAppBar
        ? Scaffold(
            appBar: AppBar(title: Text(title)),
            body: body,
          )
        : body;
  }
}
