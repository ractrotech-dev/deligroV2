// A debug-only way to see the Earnings tab on a phone or emulator without a
// server or a signed-in rider: the real shell, screens and theme over the
// fixture earnings backend.
//
//   flutter run -t tool/earnings_preview.dart --dart-define=FIXTURES=true
//     [--dart-define=FIXTURE_EARNINGS=paid|owing|empty|off]
//     [--dart-define=PREVIEW_ROUTE=/earnings/statement]   where to start
//     [--dart-define=PREVIEW_DARK=true]
//     [--dart-define=PREVIEW_REAL_SHARE=true]   use the phone's share sheet
//         instead of showing the PDF/CSV inside the app
//
// Without PREVIEW_REAL_SHARE, "Save PDF" opens the PDF it made in an in-app
// viewer and "Share CSV" shows the CSV text, so the files can be inspected on
// an emulator that has no PDF app.
//
// Not part of the app: nothing imports this file, and a release build refuses
// the fixture backend anyway.
import 'dart:typed_data';

import 'package:deligro_rider/core/statement_export.dart';
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/features/shell/rider_shell.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/earnings.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:printing/printing.dart';
import 'package:shared_preferences/shared_preferences.dart';

final _navigator = GlobalKey<NavigatorState>();

class _InAppSharer implements StatementSharer {
  @override
  Future<void> sharePdf(Uint8List bytes, String fileName) async {
    await _navigator.currentState!.push(
      MaterialPageRoute<void>(
        builder: (_) => Scaffold(
          appBar: AppBar(
            title: Text(fileName, style: const TextStyle(fontSize: 13)),
          ),
          body: PdfPreview(
            build: (_) => bytes,
            useActions: false,
            canChangePageFormat: false,
            canChangeOrientation: false,
            canDebug: false,
          ),
        ),
      ),
    );
  }

  @override
  Future<void> shareCsv(String csv, String fileName) async {
    await showDialog<void>(
      context: _navigator.currentContext!,
      builder: (_) => AlertDialog(
        title: Text(fileName, style: const TextStyle(fontSize: 13)),
        content: SingleChildScrollView(
          child: SelectableText(csv, style: const TextStyle(fontSize: 10)),
        ),
      ),
    );
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (!fixturesEnabled) {
    throw StateError(
      'run with --dart-define=FIXTURES=true in a debug or profile build',
    );
  }
  final prefs = await SharedPreferences.getInstance();
  const route = String.fromEnvironment(
    'PREVIEW_ROUTE',
    defaultValue: '/earnings',
  );
  const dark = bool.fromEnvironment('PREVIEW_DARK');
  const realShare = bool.fromEnvironment('PREVIEW_REAL_SHARE');
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      if (!realShare) statementSharerProvider.overrideWithValue(_InAppSharer()),
      meProvider.overrideWith(
        (_) async => RiderMe(
          id: 'preview',
          name: 'Ravi Kumar',
          riderCode: 'DR-0042',
          availability: RiderAvailabilityDto(
            isOnline: true,
            onlineSince: DateTime.now(),
            lastFixAt: DateTime.now(),
          ),
          phase: 'online',
        ),
      ),
    ],
  );
  final router = GoRouter(
    navigatorKey: _navigator,
    initialLocation: route,
    routes: [
      StatefulShellRoute.indexedStack(
        builder: (_, _, shell) => RiderShell(shell: shell),
        branches: [
          for (final tab in riderTabs) StatefulShellBranch(routes: [tab.route]),
        ],
      ),
    ],
  );
  runApp(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        debugShowCheckedModeBanner: false,
        theme: buildTheme(Brightness.light),
        darkTheme: buildTheme(Brightness.dark),
        themeMode: dark ? ThemeMode.dark : ThemeMode.system,
        routerConfig: router,
      ),
    ),
  );
}
