import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/env.dart';
import '../../core/updates.dart';
import '../../state/prefs.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';

/// Language, theme, version and updates, sign out.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  bool _checking = false;

  Future<void> _checkUpdates() async {
    setState(() => _checking = true);
    final v = await ref.read(managerRepoProvider).appVersion();
    if (!mounted) return;
    setState(() => _checking = false);
    if (v == null) {
      showSnack(context, 'Couldn\'t check right now.');
    } else if (!v.updateAvailable) {
      showSnack(context, 'You\'re on the latest version.');
    } else {
      await showUpdateDialog(context, v);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final theme = ref.watch(themeModeProvider);
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text('Settings')),
      body: ListView(
        children: [
          GroupLabel('Theme'),
          RadioGroup<ThemeMode>(
            groupValue: theme,
            onChanged: (v) => ref.read(themeModeProvider.notifier).set(v ?? ThemeMode.system),
            child: Column(
              children: [
                RadioListTile<ThemeMode>(value: ThemeMode.system, title: Text('Same as phone')),
                RadioListTile<ThemeMode>(value: ThemeMode.light, title: Text('Light')),
                RadioListTile<ThemeMode>(value: ThemeMode.dark, title: Text('Dark')),
              ],
            ),
          ),
          GroupLabel('App'),
          ListTile(
            leading: Icon(Icons.info_outline, color: c.ink),
            title: Text('Version'),
            subtitle: Text('${Env.versionName} (${Env.versionCode})', style: dataStyle(context, size: 13)),
          ),
          ListTile(
            key: const Key('check-updates'),
            leading: Icon(Icons.system_update_outlined, color: c.ink),
            title: Text('Check for updates'),
            trailing: _checking ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : null,
            onTap: _checking ? null : _checkUpdates,
          ),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.all(16),
            child: OutlinedButton.icon(
              key: const Key('sign-out'),
              onPressed: () => ref.read(authRepoProvider).signOut(),
              icon: Icon(Icons.logout, color: c.deal),
              label: Text('Sign out', style: TextStyle(color: c.deal)),
            ),
          ),
        ],
      ),
    );
  }
}
