import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/i18n.dart';
import '../../core/ring.dart';
import '../../theme/app_theme.dart';

/// The phone's ring readiness, re-read whenever the app comes back to the
/// front (the vendor may have just changed a setting).
class RingSetupNotifier extends AsyncNotifier<RingSetup?> {
  AppLifecycleListener? _life;

  @override
  Future<RingSetup?> build() {
    _life ??= AppLifecycleListener(onResume: () => ref.invalidateSelf());
    ref.onDispose(() {
      _life?.dispose();
      _life = null;
    });
    return ref.read(ringChannelProvider).setup();
  }
}

final ringSetupProvider = AsyncNotifierProvider.autoDispose<RingSetupNotifier, RingSetup?>(RingSetupNotifier.new);

/// Settings → New-order alerts: each thing that can stop the ring, its state,
/// and the system screen that fixes it; plus a test ring.
class RingSetupSection extends ConsumerWidget {
  const RingSetupSection({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final setup = ref.watch(ringSetupProvider).value;
    final ch = ref.read(ringChannelProvider);
    if (setup == null) {
      return Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
        child: Text(tr(ref, 'Alert settings can\'t be read on this phone.', 'इस फ़ोन पर अलर्ट सेटिंग नहीं पढ़ी जा सकती।'),
            style: TextStyle(color: c.muted)),
      );
    }

    Widget row(bool ok, String en, String hi, String fixEn, String fixHi, String which) => ListTile(
          leading: Icon(ok ? Icons.check_circle_rounded : Icons.error_rounded, color: ok ? c.green : c.deal),
          title: Text(tr(ref, en, hi), style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: ok ? null : Text(tr(ref, fixEn, fixHi)),
          trailing: ok
              ? null
              : TextButton(onPressed: () => ch.openSettings(which), child: Text(tr(ref, 'Fix', 'ठीक करें'))),
        );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        row(setup.notifications, 'Notifications', 'सूचनाएँ', 'Turn on notifications so orders can ring.',
            'ऑर्डर बजने के लिए सूचनाएँ चालू करें।', 'notifications'),
        row(setup.fullScreen, 'Full-screen alerts', 'फ़ुल-स्क्रीन अलर्ट', 'Allow it so a new order lights up a locked phone.',
            'लॉक फ़ोन पर नया ऑर्डर दिखे, इसके लिए इसे अनुमति दें।', 'fullScreen'),
        row(setup.batteryUnrestricted, 'Battery: unrestricted', 'बैटरी: बिना रोक-टोक', 'Battery saving can stop the ring. Set the app to unrestricted.',
            'बैटरी सेविंग रिंग रोक सकती है। ऐप को बिना रोक-टोक पर रखें।', 'battery'),
        if (setup.hasAutostart)
          ListTile(
            leading: Icon(Icons.restart_alt_rounded, color: c.muted),
            title: Text(tr(ref, 'Autostart (${setup.manufacturer})', 'ऑटोस्टार्ट (${setup.manufacturer})'),
                style: const TextStyle(fontWeight: FontWeight.w600)),
            subtitle: Text(tr(ref, 'Your phone has its own switch — turn Autostart on for Deligro Partner.',
                'आपके फ़ोन में अलग स्विच है — Deligro पार्टनर के लिए ऑटोस्टार्ट चालू करें।')),
            trailing: TextButton(onPressed: () => ch.openSettings('autostart'), child: Text(tr(ref, 'Open', 'खोलें'))),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 0),
          child: OutlinedButton.icon(
            onPressed: () async {
              await ch.start('vendor:test', title: trNow(ref, 'Test ring', 'टेस्ट रिंग'), body: trNow(ref, 'This is how a new order sounds.', 'नया ऑर्डर ऐसे बजेगा।'), timeoutSec: 6);
              unawaited(Future.delayed(const Duration(seconds: 6), () => ch.stop('vendor:test')));
            },
            icon: const Icon(Icons.notifications_active_outlined),
            label: Text(tr(ref, 'Play a test ring', 'टेस्ट रिंग बजाएँ')),
          ),
        ),
      ],
    );
  }
}

/// On the Orders tab when something on this phone can stop the ring.
class RingWarningBanner extends ConsumerWidget {
  const RingWarningBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final setup = ref.watch(ringSetupProvider).value;
    if (setup == null || setup.ready) return const SizedBox.shrink();
    final c = context.colors;
    return Material(
      color: c.dealSoft,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => context.push('/more/settings'),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            children: [
              Icon(Icons.notifications_off_rounded, color: c.deal, size: 20),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  tr(ref, 'New orders may not ring on this phone. Tap to fix.', 'इस फ़ोन पर नए ऑर्डर शायद न बजें। ठीक करने के लिए टैप करें।'),
                  style: TextStyle(color: c.deal, fontWeight: FontWeight.w600, fontSize: 13),
                ),
              ),
              Icon(Icons.chevron_right_rounded, color: c.deal),
            ],
          ),
        ),
      ),
    );
  }
}
