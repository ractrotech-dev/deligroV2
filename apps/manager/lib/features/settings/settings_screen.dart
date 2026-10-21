import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/env.dart';
import '../../core/i18n.dart';
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
      showSnack(context, trNow(ref, 'Couldn\'t check right now.', 'अभी जाँच नहीं हो सकी।'));
    } else if (!v.updateAvailable) {
      showSnack(context, trNow(ref, 'You\'re on the latest version.', 'आप नया वर्ज़न चला रहे हैं।'));
    } else {
      await showUpdateDialog(context, v);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final lang = ref.watch(langProvider);
    final theme = ref.watch(themeModeProvider);
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(tr(ref, 'Settings', 'सेटिंग्स'))),
      body: ListView(
        children: [
          GroupLabel(tr(ref, 'Language', 'भाषा')),
          RadioGroup<String>(
            groupValue: lang,
            onChanged: (v) => ref.read(langProvider.notifier).set(v ?? 'en'),
            child: const Column(
              children: [
                RadioListTile<String>(key: Key('lang-en'), value: 'en', title: Text('English')),
                RadioListTile<String>(key: Key('lang-hi'), value: 'hi', title: Text('हिन्दी')),
              ],
            ),
          ),
          GroupLabel(tr(ref, 'Theme', 'थीम')),
          RadioGroup<ThemeMode>(
            groupValue: theme,
            onChanged: (v) => ref.read(themeModeProvider.notifier).set(v ?? ThemeMode.system),
            child: Column(
              children: [
                RadioListTile<ThemeMode>(value: ThemeMode.system, title: Text(tr(ref, 'Same as phone', 'फ़ोन जैसा'))),
                RadioListTile<ThemeMode>(value: ThemeMode.light, title: Text(tr(ref, 'Light', 'हल्का'))),
                RadioListTile<ThemeMode>(value: ThemeMode.dark, title: Text(tr(ref, 'Dark', 'गहरा'))),
              ],
            ),
          ),
          GroupLabel(tr(ref, 'App', 'ऐप')),
          ListTile(
            leading: Icon(Icons.info_outline, color: c.ink),
            title: Text(tr(ref, 'Version', 'वर्ज़न')),
            subtitle: Text('${Env.versionName} (${Env.versionCode})', style: dataStyle(context, size: 13)),
          ),
          ListTile(
            key: const Key('check-updates'),
            leading: Icon(Icons.system_update_outlined, color: c.ink),
            title: Text(tr(ref, 'Check for updates', 'अपडेट देखें')),
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
              label: Text(tr(ref, 'Sign out', 'साइन आउट'), style: TextStyle(color: c.deal)),
            ),
          ),
        ],
      ),
    );
  }
}
