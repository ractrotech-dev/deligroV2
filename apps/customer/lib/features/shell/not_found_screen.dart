import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../theme/app_theme.dart';

/// A link the app has no page for. The customer gets a sentence and a way home,
/// not a framework error.
class NotFoundScreen extends StatelessWidget {
  const NotFoundScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: const Text('Page not found')),
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
                textAlign: TextAlign.center,
                style: TextStyle(color: c.muted, fontSize: 15, height: 1.4),
              ),
              const SizedBox(height: 20),
              FilledButton(
                onPressed: () => context.go('/'),
                child: const Text('Go to Home'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
