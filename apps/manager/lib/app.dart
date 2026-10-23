import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/push.dart';
import 'core/secure_screens.dart';
import 'core/updates.dart';
import 'router.dart';
import 'state/prefs.dart';
import 'state/providers.dart';
import 'theme/app_theme.dart';
import 'widgets/splash.dart';

class ManagerApp extends ConsumerStatefulWidget {
  const ManagerApp({super.key});

  @override
  ConsumerState<ManagerApp> createState() => _ManagerAppState();
}

class _ManagerAppState extends ConsumerState<ManagerApp> {
  SecureScreenController? _secure;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      PushService(
        ref.read(supabaseProvider).auth,
        ref.read(managerRepoProvider),
        ref.read(routerProvider),
      ).start();
      // Finance and customer screens stay out of screenshots and the recents thumbnail.
      _secure = SecureScreenController(router: ref.read(routerProvider))..start();
      _checkForUpdate();
    });
  }

  @override
  void dispose() {
    _secure?.dispose();
    super.dispose();
  }

  /// `/api/app-version?app=manager` — admins publish the APK in Admin → Settings.
  Future<void> _checkForUpdate() async {
    final v = await ref.read(managerRepoProvider).appVersion();
    final ctx = rootNavigatorKey.currentContext;
    if (v == null || !v.updateAvailable || ctx == null || !ctx.mounted) return;
    await showUpdateDialog(ctx, v);
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'Deligro Manager',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: ref.watch(themeModeProvider),
      routerConfig: ref.watch(routerProvider),
      builder: (context, child) => SplashOverlay(child: child ?? const SizedBox.shrink()),
    );
  }
}
