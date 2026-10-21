import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../config/env.dart';
import '../../core/i18n.dart';
import '../../state/prefs.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final lang = ref.watch(langProvider);
    final theme = ref.watch(themeModeProvider);

    Widget heading(String text) => Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
          child: Text(text,
              style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w700, letterSpacing: .4)),
        );

    return Scaffold(
      appBar: AppBar(title: Text(tr(ref, 'Settings', 'सेटिंग्स'))),
      body: ListView(
        children: [
          heading(tr(ref, 'LANGUAGE', 'भाषा')),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'en', label: Text('English')),
                ButtonSegment(value: 'hi', label: Text('हिन्दी')),
              ],
              selected: {lang},
              showSelectedIcon: false,
              onSelectionChanged: (s) => ref.read(langProvider.notifier).set(s.first),
            ),
          ),
          heading(tr(ref, 'APPEARANCE', 'दिखावट')),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: SegmentedButton<ThemeMode>(
              segments: [
                ButtonSegment(value: ThemeMode.system, label: Text(tr(ref, 'System', 'फ़ोन जैसा'))),
                ButtonSegment(value: ThemeMode.light, label: Text(tr(ref, 'Light', 'लाइट'))),
                ButtonSegment(value: ThemeMode.dark, label: Text(tr(ref, 'Dark', 'डार्क'))),
              ],
              selected: {theme},
              showSelectedIcon: false,
              onSelectionChanged: (s) => ref.read(themeModeProvider.notifier).set(s.first),
            ),
          ),
          heading(tr(ref, 'ACCOUNT', 'अकाउंट')),
          ListTile(
            leading: Icon(Icons.logout_rounded, color: c.deal),
            title: Text(tr(ref, 'Sign out', 'साइन आउट'),
                style: TextStyle(color: c.deal, fontWeight: FontWeight.w700)),
            onTap: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (d) => AlertDialog(
                  title: Text(trNow(ref, 'Sign out?', 'साइन आउट करें?')),
                  content: Text(trNow(ref, 'You will stop getting new-order alerts on this phone until you sign in again.',
                      'दोबारा साइन इन करने तक इस फ़ोन पर नए ऑर्डर की सूचना नहीं आएगी।')),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(d, false), child: Text(trNow(ref, 'Cancel', 'रद्द करें'))),
                    FilledButton(onPressed: () => Navigator.pop(d, true), child: Text(trNow(ref, 'Sign out', 'साइन आउट'))),
                  ],
                ),
              );
              if (ok == true) await ref.read(authRepoProvider).signOut();
            },
          ),
          const SizedBox(height: 24),
          Center(
            child: Text('Deligro Partner 2.0.0 (${Env.versionCode})',
                style: TextStyle(color: c.muted, fontSize: 12.5)),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}
