import 'package:flutter/material.dart';

/// Shown when start-up itself fails (no network for Supabase, a broken
/// install). Without it the native splash stays up for ever, which looks like
/// the app won't open. English and Hindi together: the language setting lives
/// in storage that may be what failed.
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
                  const Text("Deligro Partner couldn't start",
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 4),
                  const Text('डेलिग्रो पार्टनर शुरू नहीं हो पाया',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 10),
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
