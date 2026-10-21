import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/env.dart';
import '../../state/prefs.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import 'ring_setup.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final theme = ref.watch(themeModeProvider);

    Widget heading(String text) => Padding(
      padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
      child: Text(
        text,
        style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w700, letterSpacing: .4),
      ),
    );

    return Scaffold(
      appBar: AppBar(title: Text('Settings')),
      body: ListView(
        children: [
          heading('APPEARANCE'),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: SegmentedButton<ThemeMode>(
              segments: [
                ButtonSegment(value: ThemeMode.system, label: Text('System')),
                ButtonSegment(value: ThemeMode.light, label: Text('Light')),
                ButtonSegment(value: ThemeMode.dark, label: Text('Dark')),
              ],
              selected: {theme},
              showSelectedIcon: false,
              onSelectionChanged: (s) => ref.read(themeModeProvider.notifier).set(s.first),
            ),
          ),
          heading('NEW-ORDER ALERTS'),
          const RingSetupSection(),
          heading('ACCOUNT'),
          ListTile(
            leading: Icon(Icons.logout_rounded, color: c.deal),
            title: Text(
              'Sign out',
              style: TextStyle(color: c.deal, fontWeight: FontWeight.w700),
            ),
            onTap: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (d) => AlertDialog(
                  title: Text('Sign out?'),
                  content: Text('You will stop getting new-order alerts on this phone until you sign in again.'),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(d, false), child: Text('Cancel')),
                    FilledButton(onPressed: () => Navigator.pop(d, true), child: Text('Sign out')),
                  ],
                ),
              );
              if (ok == true) await ref.read(authRepoProvider).signOut();
            },
          ),
          const SizedBox(height: 24),
          Center(
            child: Text('Deligro Partner 2.0.0 (${Env.versionCode})', style: TextStyle(color: c.muted, fontSize: 12.5)),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}
