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

  await initializeDateFormatting('en_IN');
  await Supabase.initialize(url: Env.supabaseUrl, publishableKey: Env.supabaseAnonKey);
  final prefs = await SharedPreferences.getInstance();

  runApp(ProviderScope(
    overrides: [prefsProvider.overrideWithValue(prefs)],
    child: const DeligroApp(),
  ));
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
