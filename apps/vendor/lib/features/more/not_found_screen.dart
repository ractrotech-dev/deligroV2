import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../theme/app_theme.dart';

/// A link the app has no page for: an old notification, or a newer server's. The
/// shop gets a sentence and a way out, not a framework error.
class NotFoundScreen extends StatelessWidget {
  const NotFoundScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: Text('Page not found')),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.link_off_rounded, size: 44, color: c.muted),
              const SizedBox(height: 12),
              Text(
                'This page isn\'t in the app. The link may be old, or you may need to update the app.',
                key: const Key('not-found-text'),
                textAlign: TextAlign.center,
                style: TextStyle(color: c.muted, fontSize: 15, height: 1.4),
              ),
              const SizedBox(height: 20),
              FilledButton(
                key: const Key('not-found-home'),
                onPressed: () => context.go('/'),
                child: Text('Go to Home'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
