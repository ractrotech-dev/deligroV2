import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/push.dart';
import 'core/secure_screens.dart';
import 'core/updates.dart';
import 'models/account.dart';
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

class _ManagerAppState extends ConsumerState<ManagerApp> with WidgetsBindingObserver {
  SecureScreenController? _secure;
  DateTime _updateCheckedAt = DateTime.now();
  bool _updateOffered = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      PushService(
        ref.read(supabaseProvider).auth,
        ref.read(managerRepoProvider),
        ref.read(routerProvider),
      ).start();
      // Finance and customer screens stay out of screenshots and the recents thumbnail.
      _secure = SecureScreenController(router: ref.read(routerProvider))..start();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _secure?.dispose();
    super.dispose();
  }

  /// A required update published while the app was in the background holds as
  /// soon as it comes back (the router sends every screen to the update screen).
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    final now = DateTime.now();
    if (now.difference(_updateCheckedAt) < updateRecheckEvery) return;
    _updateCheckedAt = now;
    ref.read(updateProvider.notifier).recheck();
  }

  /// An optional update is offered once per launch. A required one is the router's job.
  void _offerUpdate(AppVersionInfo? v) {
    if (_updateOffered || v == null || !v.updateAvailable || v.forceUpdate) return;
    _updateOffered = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final ctx = rootNavigatorKey.currentContext;
      if (!mounted || ctx == null || !ctx.mounted) return;
      showUpdateDialog(ctx, v);
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(updateProvider, (_, next) => _offerUpdate(next.value));
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
