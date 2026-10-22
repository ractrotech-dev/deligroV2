import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../config/env.dart';
import '../../core/update_check.dart';
import '../notifications/notification_settings.dart';
import '../onboarding/location_disclosure_screen.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart' show showSnack;
import '../../widgets/rows.dart';

/// Location, version and updates, privacy, and sign out.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

enum _SigningOut { no, here, everywhere }

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  _SigningOut _signingOut = _SigningOut.no;
  bool _checking = false;

  Future<void> _checkForUpdates() async {
    if (_checking) return;
    setState(() => _checking = true);
    try {
      final update = await fetchAppUpdate(ref.read(apiProvider));
      if (!mounted) return;
      if (update == null) {
        showSnack(context, "Couldn't check for updates. Try again.");
      } else if (!update.updateAvailable) {
        showSnack(context, "You're on the latest version.");
      } else if (update.forceUpdate) {
        // The update gate covers the app as soon as it re-reads the answer.
        ref.invalidate(updateProvider);
      } else {
        await showUpdateSheet(context, update);
      }
    } finally {
      if (mounted) setState(() => _checking = false);
    }
  }

  /// Offline first, so dispatch stops offering; then the session ends. The
  /// offline call never throws and gives up after 5 s (ruling R11), and a
  /// throw from anything else still does not keep the rider signed in.
  Future<void> _signOut({required bool everywhere}) async {
    if (_signingOut != _SigningOut.no) return;
    if (ref.read(meProvider).value?.activeDeliveryId != null) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (dialog) => AlertDialog(
          content: Text("You're carrying an order. Sign out anyway?"),
          actions: [
            TextButton(
              key: const Key('confirm-cancel'),
              onPressed: () => Navigator.pop(dialog, false),
              child: Text('Cancel'),
            ),
            TextButton(
              key: const Key('confirm-ok'),
              onPressed: () => Navigator.pop(dialog, true),
              child: Text('Sign out'),
            ),
          ],
        ),
      );
      if (ok != true || !mounted) return;
    }
    setState(
      () =>
          _signingOut = everywhere ? _SigningOut.everywhere : _SigningOut.here,
    );
    try {
      try {
        await ref.read(riderRepoProvider).signoutOffline();
      } catch (_) {
        // Never blocks sign-out.
      }
      await ref.read(authRepoProvider).signOut(everywhere: everywhere);
    } finally {
      if (mounted) setState(() => _signingOut = _SigningOut.no);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final busy = _signingOut != _SigningOut.no;
    Widget progress(Key key) => SizedBox(
      key: key,
      width: 22,
      height: 22,
      child: const CircularProgressIndicator(strokeWidth: 2.5),
    );

    return Scaffold(
      appBar: AppBar(title: Text('Settings')),
      body: SafeArea(
        bottom: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              RowsLabel('Location'),
              RowsCard(
                children: [
                  NavRow(
                    key: const Key('row-location'),
                    icon: Icons.location_on_outlined,
                    title: 'Location disclosure',
                    subtitle: 'How the app uses your location',
                    onTap: () => context.push(locationDisclosureReadPath),
                  ),
                ],
              ),
              RowsLabel('Notifications'),
              const NotificationSwitches(),
              RowsLabel('App'),
              RowsCard(
                children: [
                  NavRow(
                    icon: Icons.info_outline_rounded,
                    title: 'App version',
                    trailing: Text(
                      '${Env.versionName} (${Env.versionCode})',
                      style: dataStyle(
                        context,
                        size: 14,
                        weight: FontWeight.w600,
                      ).copyWith(color: c.muted),
                    ),
                  ),
                  NavRow(
                    key: const Key('row-check-updates'),
                    icon: Icons.system_update_alt_rounded,
                    title: 'Check for updates',
                    trailing: _checking
                        ? progress(const Key('update-progress'))
                        : null,
                    onTap: _checking ? null : _checkForUpdates,
                  ),
                ],
              ),
              RowsLabel('Privacy'),
              RowsCard(
                children: [
                  NavRow(
                    key: const Key('row-privacy'),
                    icon: Icons.shield_outlined,
                    title: 'Privacy & data',
                    subtitle: 'What the app holds about you',
                    onTap: () => context.push('/more/privacy'),
                  ),
                ],
              ),
              RowsLabel('Account'),
              RowsCard(
                children: [
                  NavRow(
                    key: const Key('row-signout'),
                    icon: Icons.logout_rounded,
                    title: 'Sign out',
                    trailing: _signingOut == _SigningOut.here
                        ? progress(const Key('signout-progress'))
                        : null,
                    onTap: busy ? null : () => _signOut(everywhere: false),
                  ),
                  NavRow(
                    key: const Key('row-signout-all'),
                    icon: Icons.devices_other_rounded,
                    title: 'Sign out of all devices',
                    destructive: true,
                    trailing: _signingOut == _SigningOut.everywhere
                        ? progress(const Key('signout-progress'))
                        : null,
                    onTap: busy ? null : () => _signOut(everywhere: true),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
