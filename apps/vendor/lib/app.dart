import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/i18n.dart';
import 'core/ring.dart';
import 'router.dart';
import 'state/prefs.dart';
import 'state/providers.dart';
import 'theme/app_theme.dart';
import 'widgets/splash.dart';

class PartnerApp extends ConsumerWidget {
  const PartnerApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lang = ref.watch(langProvider);
    // Signed out on this phone: nothing here should keep ringing.
    ref.listen(signedInProvider, (was, now) {
      if (was == true && !now) ref.read(boardRingerProvider.notifier).stopAll();
    });
    return MaterialApp.router(
      title: 'Deligro Partner',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: ref.watch(themeModeProvider),
      locale: Locale(lang, 'IN'),
      supportedLocales: const [Locale('en', 'IN'), Locale('hi', 'IN')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      routerConfig: ref.watch(routerProvider),
      builder: (context, child) => SplashOverlay(child: child ?? const SizedBox.shrink()),
    );
  }
}
