import 'package:flutter/material.dart';

/// Shown when startup itself fails (Supabase init, prefs). A failure there used
/// to leave the native splash up forever, which looks like the app won't open.
class StartupFailed extends StatelessWidget {
  const StartupFailed({super.key, required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        home: Scaffold(
          body: SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Text('Deligro Manager couldn\'t start',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 8),
                  Text('$error',
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 13, color: Colors.black54)),
                  const SizedBox(height: 20),
                  FilledButton(onPressed: onRetry, child: const Text('Retry')),
                ],
              ),
            ),
          ),
        ),
      );
}

/// Built without `--dart-define-from-file=env/prod.json`. Says so plainly
/// instead of failing into a blank screen.
class MissingConfig extends StatelessWidget {
  const MissingConfig({super.key});

  @override
  Widget build(BuildContext context) => const MaterialApp(
        home: Scaffold(
          body: Center(
            child: Padding(
              padding: EdgeInsets.all(24),
              child: Text(
                'This build has no server configuration.\n'
                'Build with --dart-define-from-file=env/prod.json',
                textAlign: TextAlign.center,
              ),
            ),
          ),
        ),
      );
}
