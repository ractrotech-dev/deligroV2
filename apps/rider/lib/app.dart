import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import 'core/app_update.dart';
import 'core/push.dart';
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

class _RiderAppState extends ConsumerState<RiderApp> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      PushService(
        ref.read(supabaseProvider).auth,
        ref.read(apiProvider),
        ref.read(routerProvider),
      ).start();
      _checkForUpdate();
    });
  }

  Future<void> _checkForUpdate() async {
    final v = await fetchAppUpdate(ref.read(apiProvider));
    final ctx = rootNavigatorKey.currentContext;
    if (v == null || !v.updateAvailable || v.apkUrl.isEmpty || ctx == null || !ctx.mounted) return;
    await showDialog<void>(
      context: ctx,
      barrierDismissible: !v.forceUpdate,
      builder: (dialog) => PopScope(
        canPop: !v.forceUpdate,
        child: AlertDialog(
          title: Text(v.forceUpdate ? 'Update required' : 'Update available'),
          content: Text(v.notes.isNotEmpty
              ? v.notes
              : 'A new version of Deligro Rider is ready. Update to keep deliveries running smoothly.'),
          actions: [
            if (!v.forceUpdate)
              TextButton(onPressed: () => Navigator.pop(dialog), child: const Text('Later')),
            FilledButton(
              onPressed: () => launchUrl(Uri.parse(v.apkUrl), mode: LaunchMode.externalApplication),
              child: const Text('Update'),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'Deligro Rider',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: ref.watch(themeModeProvider),
      routerConfig: ref.watch(routerProvider),
      builder: (context, child) => SplashOverlay(child: child ?? const SizedBox.shrink()),
    );
  }
}
