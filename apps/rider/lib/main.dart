import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'app.dart';
import 'config/env.dart';
import 'state/prefs.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  if (!Env.configured) {
    runApp(const _MissingConfig());
    return;
  }

  // A failure here used to leave the native splash up forever, which looks
  // like the app won't open. Show what went wrong instead.
  final SharedPreferences prefs;
  try {
    await initializeDateFormatting('en_IN');
    await Supabase.initialize(url: Env.supabaseUrl, publishableKey: Env.supabaseAnonKey);
    prefs = await SharedPreferences.getInstance();
  } catch (e, st) {
    debugPrint('startup: $e\n$st');
    runApp(StartupFailed(error: e));
    return;
  }

  runApp(ProviderScope(
    overrides: [prefsProvider.overrideWithValue(prefs)],
    child: const RiderApp(),
  ));
}

/// Shown when initialisation throws, instead of leaving the native splash up forever.
class StartupFailed extends StatelessWidget {
  const StartupFailed({super.key, required this.error});

  final Object error;

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
                  const Text('Deligro Rider couldn\'t start',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 8),
                  Text('$error',
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 13, color: Colors.black54)),
                  const SizedBox(height: 20),
                  FilledButton(onPressed: main, child: const Text('Retry')),
                ],
              ),
            ),
          ),
        ),
      );
}

/// Built without `--dart-define-from-file=env/prod.json`. Says so plainly
/// instead of failing closed into a blank screen.
class _MissingConfig extends StatelessWidget {
  const _MissingConfig();

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
