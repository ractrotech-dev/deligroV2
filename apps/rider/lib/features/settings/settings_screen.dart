import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../config/env.dart';
import '../../core/ring.dart';
import '../../core/update_check.dart';
import '../onboarding/location_disclosure_screen.dart';
import '../../state/prefs.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart' show showSnack;
import '../../widgets/rows.dart';

/// Location, navigation app, alerts, version and updates, privacy, and sign out.
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

  RiderPrefs get _prefs => ref.read(riderPrefsProvider);

  Future<void> _setNavApp(String app) async {
    setState(() {});
    await _prefs.setNavApp(app);
    if (mounted) setState(() {});
  }

  Future<void> _setSound(bool on) async {
    final write = _prefs.setRingSound(on);
    setState(() {});
    await write;
  }

  Future<void> _setVibrate(bool on) async {
    final write = _prefs.setRingVibrate(on);
    setState(() {});
    await write;
  }

  /// Rings for 3 s the way a new order will ring with the switches as they are.
  Future<void> _testAlert() async {
    final out = RingOutput.resolve(held: false, soundOn: _prefs.ringSound, vibrateOn: _prefs.ringVibrate);
    if (out.silent) {
      showSnack(context, 'Turn on sound or vibration to test the alert.');
      return;
    }
    final ok = await ref.read(ringChannelProvider).testAlert(_prefs);
    if (!ok && mounted) {
      showSnack(context, "The phone wouldn't ring. Check the alert channel settings below.");
    }
  }

  Widget _navRow(String app, IconData icon, String title, String subtitle) {
    final selected = _prefs.navApp == app;
    return NavRow(
      key: Key('row-nav-$app'),
      icon: icon,
      title: title,
      subtitle: subtitle,
      trailing: selected
          ? Icon(Icons.check_circle_rounded, key: Key('nav-$app-selected'), color: context.colors.green)
          : Icon(Icons.radio_button_unchecked_rounded, color: context.colors.muted),
      onTap: () => _setNavApp(app),
    );
  }

  Widget _switchRow(Key key, IconData icon, String title, String subtitle, bool value, ValueChanged<bool> onChanged) =>
      NavRow(
        icon: icon,
        title: title,
        subtitle: subtitle,
        trailing: Switch(key: key, value: value, onChanged: onChanged),
        onTap: () => onChanged(!value),
      );

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
              RowsLabel('Navigation'),
              RowsCard(
                children: [
                  _navRow('google', Icons.map_outlined, 'Google Maps', 'Turn-by-turn directions in Google Maps'),
                  _navRow('other', Icons.apps_rounded, 'Other app', 'Choose from the navigation apps on your phone'),
                ],
              ),
              RowsLabel('Alerts'),
              RowsCard(
                children: [
                  _switchRow(
                    const Key('switch-sound'),
                    Icons.volume_up_outlined,
                    'Alert sound',
                    'Play a sound for new orders',
                    _prefs.ringSound,
                    _setSound,
                  ),
                  _switchRow(
                    const Key('switch-vibrate'),
                    Icons.vibration_rounded,
                    'Vibration',
                    'Vibrate for new orders',
                    _prefs.ringVibrate,
                    _setVibrate,
                  ),
                  NavRow(
                    key: const Key('row-test-alert'),
                    icon: Icons.notifications_active_outlined,
                    title: 'Test the alert',
                    subtitle: 'Rings for 3 seconds',
                    onTap: _testAlert,
                  ),
                  NavRow(
                    key: const Key('row-channel-settings'),
                    icon: Icons.tune_rounded,
                    title: 'Alert channel settings',
                    subtitle: "Your phone's settings for new-order alerts",
                    onTap: () => ref.read(ringChannelProvider).openSettings('channel'),
                  ),
                ],
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 8, 4, 0),
                child: Text(
                  'An order held for you always rings, even with sound or vibration off, because the time to answer is short.',
                  style: TextStyle(color: c.muted, fontSize: 13, height: 1.3),
                ),
              ),
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
