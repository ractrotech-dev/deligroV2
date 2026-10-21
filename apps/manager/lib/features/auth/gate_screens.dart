import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/i18n.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';

/// Signed in, `/api/manager/me` loading — or failed for a reason other than
/// "not a manager", with Retry. Never an endless spinner.
class BootScreen extends ConsumerWidget {
  const BootScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(managerMeProvider);
    final c = context.colors;
    final err = me.hasError && !me.isLoading ? me.error : null;
    return Scaffold(
      backgroundColor: c.bg,
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: err == null
                ? const CircularProgressIndicator()
                : Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.cloud_off_outlined, size: 40, color: c.muted),
                      const SizedBox(height: 12),
                      Text(
                        err is ApiException ? err.friendly : tr(ref, 'Couldn\'t load your account.', 'आपका खाता लोड नहीं हुआ।'),
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 15, color: c.ink, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 16),
                      FilledButton(
                        onPressed: () => ref.read(managerMeProvider.notifier).reload(),
                        child: Text(tr(ref, 'Retry', 'फिर कोशिश करें')),
                      ),
                      TextButton(
                        onPressed: () => ref.read(authRepoProvider).signOut(),
                        child: Text(tr(ref, 'Sign out', 'साइन आउट')),
                      ),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}

/// Signed in with an account that is not a manager or admin.
class NotManagerScreen extends ConsumerWidget {
  const NotManagerScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.badge_outlined, size: 44, color: c.accent),
                  const SizedBox(height: 14),
                  Text(
                    tr(ref, 'This account isn\'t a manager', 'यह खाता मैनेजर का नहीं है'),
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: c.ink),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    tr(
                      ref,
                      'Deligro Manager is for operations staff. Customers, shops and riders use their own apps. If you should have access, ask an admin to add you on Team.',
                      'Deligro Manager संचालन टीम के लिए है। ग्राहक, दुकानें और राइडर अपने ऐप इस्तेमाल करते हैं। अगर आपको एक्सेस चाहिए, तो एडमिन से Team में जोड़ने को कहें।',
                    ),
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 14, color: c.muted, height: 1.4),
                  ),
                  const SizedBox(height: 20),
                  FilledButton(
                    key: const Key('not-manager-sign-out'),
                    onPressed: () => ref.read(authRepoProvider).signOut(),
                    style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                    child: Text(tr(ref, 'Sign out', 'साइन आउट')),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
