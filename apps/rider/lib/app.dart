import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/location_service.dart';
import 'core/push.dart';
import 'core/ring.dart';
import 'core/update_check.dart';
import 'features/jobs/jobs_screen.dart' show jobsPath;
import 'router.dart';
import 'state/prefs.dart';
import 'state/providers.dart';
import 'theme/app_theme.dart';
import 'widgets/splash.dart';

class RiderApp extends ConsumerStatefulWidget {
  const RiderApp({super.key});

  @override
  ConsumerState<RiderApp> createState() => _RiderAppState();
}

class _RiderAppState extends ConsumerState<RiderApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      PushService(
        ref.read(supabaseProvider).auth,
        ref.read(apiProvider),
        ref.read(routerProvider),
        ref.read(ringChannelProvider),
      ).start();
      _openFromRing();
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _openFromRing();
  }

  /// A tap on the ringing notification opens the app; take it to the offer.
  Future<void> _openFromRing() async {
    final route = await ref.read(ringChannelProvider).takeLaunchRoute();
    if (route == jobsPath && mounted) ref.read(routerProvider).go(jobsPath);
  }

  @override
  Widget build(BuildContext context) {
    // Alive for the whole session: it stops sharing on sign-out, and starts it
    // again for a rider who is still online when the app opens.
    ref.watch(locationServiceProvider);
    return MaterialApp.router(
      title: 'Deligro Rider',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: ref.watch(themeModeProvider),
      routerConfig: ref.watch(routerProvider),
      builder: (context, child) => SplashOverlay(
        child: UpdateGate(
          navigatorKey: rootNavigatorKey,
          child: child ?? const SizedBox.shrink(),
        ),
      ),
    );
  }
}
