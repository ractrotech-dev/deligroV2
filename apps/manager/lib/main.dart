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
    runApp(const MissingConfig());
    return;
  }

  final SharedPreferences prefs;
  try {
    await initializeDateFormatting('en_IN');
    await Supabase.initialize(url: Env.supabaseUrl, publishableKey: Env.supabaseAnonKey);
    prefs = await SharedPreferences.getInstance();
    // The app is English only; drop the language choice earlier builds saved.
    await prefs.remove('manager-lang');
  } catch (e, st) {
    debugPrint('startup: $e\n$st');
    runApp(StartupFailed(error: e, onRetry: main));
    return;
  }

  runApp(ProviderScope(
    overrides: [prefsProvider.overrideWithValue(prefs)],
    child: const ManagerApp(),
  ));
}
