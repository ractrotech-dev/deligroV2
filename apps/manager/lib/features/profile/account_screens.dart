import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/i18n.dart';
import '../../models/account.dart';
import '../../state/account.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';

final _when = DateFormat('d MMM yyyy, h:mm a', 'en_IN');
String _fmt(DateTime? t) => t == null ? '—' : _when.format(t.toLocal());

/// §15.4: every manager power, on or off, in the words the admin panel uses.
class PermissionsScreen extends ConsumerWidget {
  const PermissionsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final hi = ref.watch(langProvider) == 'hi';
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(tr(ref, 'Permissions', 'अनुमतियाँ'))),
      body: AsyncView(
        value: ref.watch(permissionsProvider),
        onRetry: () => ref.invalidate(permissionsProvider),
        builder: (list) {
          final on = list.where((p) => p.on).toList();
          final off = list.where((p) => !p.on).toList();
          return ListView(
            padding: const EdgeInsets.only(bottom: 24),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
                child: Text(
                  tr(ref, 'Set by Deligro admin. Ask an admin if you need something switched on.',
                      'ये Deligro एडमिन तय करते हैं। कुछ चालू करवाना हो तो एडमिन से कहें।'),
                  style: TextStyle(color: c.muted, fontSize: 13),
                ),
              ),
              GroupLabel(tr(ref, 'On (${on.length})', 'चालू (${on.length})')),
              for (final p in on) _PermissionRow(p: p, hi: hi),
              GroupLabel(tr(ref, 'Off (${off.length})', 'बंद (${off.length})')),
              if (off.isEmpty) EmptyLine(tr(ref, 'Everything is on.', 'सब चालू है।')),
              for (final p in off) _PermissionRow(p: p, hi: hi),
            ],
          );
        },
      ),
    );
  }
}

class _PermissionRow extends StatelessWidget {
  const _PermissionRow({required this.p, required this.hi});
  final PermissionInfo p;
  final bool hi;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListTile(
      key: Key('perm-${p.key}'),
      leading: Icon(p.on ? Icons.check_circle : Icons.remove_circle_outline, color: p.on ? c.green : c.muted),
      title: Text(hi ? p.labelHi : p.label, style: TextStyle(fontWeight: FontWeight.w600, color: c.ink)),
      subtitle: p.on ? null : Text(p.offMeans, style: TextStyle(fontSize: 12.5, color: c.muted)),
    );
  }
}

/// §15.8: the signed-in person's own audit-log entries, newest first.
class ActivityScreen extends ConsumerStatefulWidget {
  const ActivityScreen({super.key});

  @override
  ConsumerState<ActivityScreen> createState() => _ActivityScreenState();
}

class _ActivityScreenState extends ConsumerState<ActivityScreen> {
  final _items = <ActivityItem>[];
  int _page = 0;
  bool _hasMore = true;
  bool _loading = false;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load({bool reset = false}) async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
      if (reset) {
        _items.clear();
        _page = 0;
        _hasMore = true;
      }
    });
    try {
      final page = await ref.read(managerRepoProvider).activity(page: _page + 1);
      if (!mounted) return;
      setState(() {
        _items.addAll(page.items);
        _page = page.page;
        _hasMore = page.hasMore;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e);
      if (e is ApiException && e.unauthorized && mounted) await handleUnauthorized(ref, e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget body;
    if (_items.isEmpty && _loading) {
      body = const Center(child: CircularProgressIndicator());
    } else if (_items.isEmpty && _error != null) {
      body = ErrorRetry(error: _error!, onRetry: () => _load(reset: true));
    } else if (_items.isEmpty) {
      body = EmptyLine(tr(ref, 'Nothing recorded yet. Actions you take — reassigning a rider, changing a status — appear here.',
          'अभी कुछ दर्ज नहीं। आपके काम — राइडर बदलना, स्टेटस बदलना — यहाँ दिखेंगे।'));
    } else {
      body = RefreshIndicator(
        onRefresh: () => _load(reset: true),
        child: ListView.separated(
          itemCount: _items.length + 1,
          separatorBuilder: (_, _) => Divider(height: 1, color: c.line),
          itemBuilder: (context, i) {
            if (i == _items.length) {
              if (!_hasMore) return const SizedBox(height: 24);
              return Padding(
                padding: const EdgeInsets.all(16),
                child: OutlinedButton(
                  onPressed: _loading ? null : _load,
                  child: Text(_loading ? tr(ref, 'Loading…', 'लोड हो रहा है…') : tr(ref, 'Load more', 'और दिखाएँ')),
                ),
              );
            }
            final a = _items[i];
            return ListTile(
              title: Text(a.title, style: TextStyle(fontWeight: FontWeight.w600, color: c.ink)),
              subtitle: Text(
                [
                  if (a.entityId != null) '${a.entityType} ${a.entityId!.length > 8 ? a.entityId!.substring(0, 8) : a.entityId}',
                  if (a.reason != null) '“${a.reason}”',
                  _fmt(a.createdAt),
                ].join(' · '),
                style: TextStyle(fontSize: 12.5, color: c.muted),
              ),
            );
          },
        ),
      );
    }
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(tr(ref, 'My activity', 'मेरी गतिविधि'))),
      body: body,
    );
  }
}

/// §15.6: where this account is signed in; end one, or all.
class SessionsScreen extends ConsumerWidget {
  const SessionsScreen({super.key});

  Future<void> _revoke(BuildContext context, WidgetRef ref, SessionInfo s) async {
    try {
      await ref.read(managerRepoProvider).revokeSession(s.id);
      ref.invalidate(sessionsProvider);
      if (context.mounted) showSnack(context, trNow(ref, 'Signed out ${s.device}.', '${s.device} से साइन आउट हुआ।'));
    } catch (e) {
      if (context.mounted) showSnack(context, e is ApiException ? e.friendly : '$e');
    }
  }

  Future<void> _everywhere(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text(trNow(ref, 'Sign out everywhere?', 'हर जगह से साइन आउट करें?')),
        content: Text(trNow(ref, 'Every device, this one included, will need to sign in again.',
            'यह डिवाइस मिलाकर हर डिवाइस पर फिर से साइन इन करना होगा।')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: Text(trNow(ref, 'Cancel', 'रद्द करें'))),
          FilledButton(
            key: const Key('confirm-everywhere'),
            onPressed: () => Navigator.pop(d, true),
            child: Text(trNow(ref, 'Sign out everywhere', 'हर जगह से साइन आउट')),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(managerRepoProvider).signOutEverywhere();
    } catch (e) {
      // The server ended the sessions or it did not; either way this device
      // signs out, which is what was asked.
    }
    await ref.read(authRepoProvider).signOut();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(tr(ref, 'Signed-in devices', 'साइन-इन डिवाइस'))),
      body: AsyncView(
        value: ref.watch(sessionsProvider),
        onRetry: () => ref.invalidate(sessionsProvider),
        builder: (list) => ListView(
          children: [
            if (list.isEmpty) EmptyLine(tr(ref, 'No sessions found.', 'कोई सेशन नहीं मिला।')),
            for (final s in list)
              ListTile(
                key: Key('session-${s.id}'),
                leading: Icon(Icons.smartphone_outlined, color: c.ink),
                title: Row(
                  children: [
                    Flexible(child: Text(s.device, style: TextStyle(fontWeight: FontWeight.w600, color: c.ink))),
                    if (s.current) ...[
                      const SizedBox(width: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        decoration: BoxDecoration(color: c.greenSoft, borderRadius: BorderRadius.circular(999)),
                        child: Text(tr(ref, 'This device', 'यह डिवाइस'),
                            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: c.green)),
                      ),
                    ],
                  ],
                ),
                subtitle: Text(
                  '${tr(ref, 'Last active', 'आख़िरी बार सक्रिय')} ${_fmt(s.lastSeenAt)}${s.ip == null ? '' : ' · ${s.ip}'}',
                  style: TextStyle(fontSize: 12.5, color: c.muted),
                ),
                trailing: s.current
                    ? null
                    : TextButton(
                        key: Key('revoke-${s.id}'),
                        onPressed: () => _revoke(context, ref, s),
                        child: Text(tr(ref, 'Sign out', 'साइन आउट')),
                      ),
              ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: OutlinedButton.icon(
                key: const Key('sign-out-everywhere'),
                onPressed: () => _everywhere(context, ref),
                icon: Icon(Icons.logout, color: c.deal),
                label: Text(tr(ref, 'Sign out everywhere', 'हर जगह से साइन आउट'), style: TextStyle(color: c.deal)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// §15.5: change the password, after proving the current one.
class PasswordScreen extends ConsumerStatefulWidget {
  const PasswordScreen({super.key});

  @override
  ConsumerState<PasswordScreen> createState() => _PasswordScreenState();
}

class _PasswordScreenState extends ConsumerState<PasswordScreen> {
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _error;
  bool _othersStillSignedIn = false;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_next.text.length < 8) {
      setState(() => _error = trNow(ref, 'Use at least 8 characters.', 'कम से कम 8 अक्षर रखें।'));
      return;
    }
    if (_next.text != _confirm.text) {
      setState(() => _error = trNow(ref, 'The new passwords don\'t match.', 'नए पासवर्ड मेल नहीं खाते।'));
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final othersStillSignedIn = await ref.read(managerRepoProvider).changePassword(_current.text, _next.text);
      if (!mounted) return;
      if (othersStillSignedIn) {
        // Stay here and say it: the reason to change a password is usually
        // someone else holding the account, and they may still be in.
        setState(() => _othersStillSignedIn = true);
        return;
      }
      showSnack(context, trNow(ref, 'Password changed.', 'पासवर्ड बदल गया।'));
      Navigator.of(context).pop();
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException ? e.friendly : '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(tr(ref, 'Change password', 'पासवर्ड बदलें'))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            key: const Key('pw-current'),
            controller: _current,
            obscureText: true,
            decoration: InputDecoration(labelText: tr(ref, 'Current password', 'मौजूदा पासवर्ड')),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('pw-next'),
            controller: _next,
            obscureText: true,
            decoration: InputDecoration(
              labelText: tr(ref, 'New password', 'नया पासवर्ड'),
              helperText: tr(ref, 'At least 8 characters', 'कम से कम 8 अक्षर'),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            key: const Key('pw-confirm'),
            controller: _confirm,
            obscureText: true,
            decoration: InputDecoration(labelText: tr(ref, 'Confirm new password', 'नया पासवर्ड दोबारा')),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
          ],
          if (_othersStillSignedIn) ...[
            const SizedBox(height: 12),
            Text(
              'Password changed, but other devices may still be signed in. '
              'Sign them out from Profile → Devices.',
              key: const Key('pw-warning'),
              style: TextStyle(color: c.deal, fontWeight: FontWeight.w600),
            ),
          ],
          const SizedBox(height: 20),
          FilledButton(
            key: const Key('pw-submit'),
            onPressed: _busy ? null : _submit,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
            child: Text(_busy ? tr(ref, 'Saving…', 'सेव हो रहा है…') : tr(ref, 'Change password', 'पासवर्ड बदलें')),
          ),
        ],
      ),
    );
  }
}

/// §15.7: one push switch per alert kind, stored on the server.
class NotificationPrefsScreen extends ConsumerWidget {
  const NotificationPrefsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final hi = ref.watch(langProvider) == 'hi';
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(tr(ref, 'Notifications', 'सूचनाएँ'))),
      body: AsyncView(
        value: ref.watch(notificationPrefsProvider),
        onRetry: () => ref.invalidate(notificationPrefsProvider),
        builder: (prefs) => ListView(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
              child: Text(
                tr(ref, 'Push alerts you receive on this account. Alerts still appear in the app when off.',
                    'इस खाते पर आने वाले पुश अलर्ट। बंद होने पर भी अलर्ट ऐप में दिखेंगे।'),
                style: TextStyle(color: c.muted, fontSize: 13),
              ),
            ),
            for (final p in prefs)
              SwitchListTile(
                key: Key('pref-${p.kind}'),
                title: Text(hi ? p.hi : p.en, style: TextStyle(color: c.ink)),
                value: p.push,
                onChanged: (v) async {
                  try {
                    await ref.read(notificationPrefsProvider.notifier).toggle(p.kind, v);
                  } catch (e) {
                    if (context.mounted) showSnack(context, e is ApiException ? e.friendly : '$e');
                  }
                },
              ),
          ],
        ),
      ),
    );
  }
}
