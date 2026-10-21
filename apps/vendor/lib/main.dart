import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'app.dart';
import 'config/env.dart';
import 'state/prefs.dart';
import 'widgets/startup_failed.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  if (!Env.configured) {
    runApp(StartupFailed(
      error: 'This build has no server configuration. '
          'Build with --dart-define-from-file=env/prod.json',
      onRetry: main,
    ));
    return;
  }

  // A failure here used to leave the native splash up forever, which looks
  // like the app won't open. Show what went wrong instead.
  final SharedPreferences prefs;
  try {
    await initializeDateFormatting('en_IN');
    await initializeDateFormatting('hi_IN');
    await Supabase.initialize(url: Env.supabaseUrl, publishableKey: Env.supabaseAnonKey);
    prefs = await SharedPreferences.getInstance();
  } catch (e, st) {
    debugPrint('startup: $e\n$st');
    runApp(StartupFailed(error: e, onRetry: main));
    return;
  }

  runApp(ProviderScope(
    overrides: [prefsProvider.overrideWithValue(prefs)],
    child: const PartnerApp(),
  ));
}
