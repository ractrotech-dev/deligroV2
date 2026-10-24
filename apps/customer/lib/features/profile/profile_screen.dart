import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../data/account_repository.dart';
import '../../state/prefs.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// Same inbox as the website's "Contact developers" row.
const _developerEmail = 'gauravm7722@gmail.com';

Future<void> _contactDeveloper(BuildContext context) async {
  final ok = await launchUrl(Uri(
    scheme: 'mailto',
    path: _developerEmail,
    query: 'subject=${Uri.encodeComponent('Deligro app feedback')}',
  ));
  if (!ok && context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('No email app found. Write to $_developerEmail')),
    );
  }
}

/// "+91 98765 43210" from whatever shape the profile row holds.
String _prettyPhone(String? raw) {
  if (raw == null || raw.isEmpty) return '';
  final d = raw.replaceAll(RegExp(r'\D'), '');
  final ten = d.length >= 10 ? d.substring(d.length - 10) : d;
  if (ten.length != 10) return raw;
  return '+91 ${ten.substring(0, 5)} ${ten.substring(5)}';
}

String _initials(String? name) {
  final parts = (name ?? '').trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return '';
  final first = parts.first.characters.first;
  final last = parts.length > 1 ? parts.last.characters.first : '';
  return (first + last).toUpperCase();
}

/// Account (app/(customer)/profile/page.tsx).
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(profileProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Account')),
      body: RefreshIndicator(
        onRefresh: () => refreshAll(ref, [profileProvider, favoritesProvider, settingsProvider]),
        child: AsyncBody<Profile?>(
          value: async,
          onRetry: () => ref.invalidate(profileProvider),
          builder: (p) => p == null ? const _SignedOut() : _Body(profile: p),
        ),
      ),
    );
  }
}

class _SignedOut extends StatelessWidget {
  const _SignedOut();

  @override
  Widget build(BuildContext context) => ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const SizedBox(height: 40),
          EmptyState(
            icon: Icons.login_rounded,
            title: 'You\'re not signed in',
            body: 'Sign in to see your orders, saved addresses, and profile.',
            action: 'Sign in',
            onAction: () => context.go('/login?next=${Uri.encodeComponent('/profile')}'),
          ),
        ],
      );
}

class _Body extends ConsumerWidget {
  const _Body({required this.profile});
  final Profile profile;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final p = profile;
    final name = p.fullName?.trim().isNotEmpty == true ? p.fullName!.trim() : null;
    final settings = ref.watch(settingsProvider).value;
    final online = settings?.featureOnlinePayment == true;
    final favCount = ref.watch(favoritesProvider).value?.length;
    final mode = ref.watch(themeModeProvider);

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
      children: [
        Row(
          children: [
            SizedBox(
              width: 64,
              height: 64,
              child: NetImage(
                url: p.avatarUrl,
                radius: 32,
                tint: 'linear-gradient(135deg,#ff9a4d,#f2660c)',
                fallback: _initials(name).isEmpty
                    ? const Icon(Icons.person_rounded, color: Colors.white, size: 30)
                    : Text(_initials(name),
                        style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w800)),
              ),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(name == null ? 'Hello there' : 'Hello, ${name.split(' ').first}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                  const SizedBox(height: 2),
                  if (p.phone?.isNotEmpty == true)
                    Text(_prettyPhone(p.phone), style: dataStyle(context, size: 13, weight: FontWeight.w600).copyWith(color: c.muted)),
                  if (p.createdAt != null)
                    Text('Member since ${DateFormat('MMMM y').format(p.createdAt!.toLocal())}',
                        style: TextStyle(fontSize: 12.5, color: c.muted)),
                ],
              ),
            ),
            IconButton(
              tooltip: 'Edit name',
              onPressed: () => _editName(context, ref, name),
              icon: const Icon(Icons.edit_outlined),
            ),
          ],
        ),
        if (!p.canOrder) ...[
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: c.pop.withValues(alpha: .18),
              borderRadius: BorderRadius.circular(radiusBlock),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.badge_outlined, size: 18, color: c.popInk),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'This is an operator account (${p.role}), so it can\'t place customer orders. '
                    'Sign in with a customer number to order food.',
                    style: TextStyle(color: c.popInk, fontSize: 13, fontWeight: FontWeight.w600, height: 1.4),
                  ),
                ),
              ],
            ),
          ),
        ],
        const _Head('Your stuff'),
        _Group(children: [
          _Row(
            icon: Icons.receipt_long_rounded,
            tone: c.accent,
            label: 'Orders',
            onTap: () => context.go('/orders'),
          ),
          _Row(
            icon: Icons.favorite_rounded,
            tone: c.deal,
            label: 'Favourites',
            detail: favCount == null || favCount == 0 ? null : '$favCount saved',
            onTap: () => context.push('/profile/favorites'),
          ),
          _Row(
            icon: Icons.location_on_rounded,
            tone: c.blue,
            label: 'Saved addresses',
            onTap: () => context.push('/profile/addresses'),
          ),
        ]),
        const _Head('Payment'),
        _Group(children: [
          _Row(
            icon: Icons.account_balance_wallet_rounded,
            tone: c.green,
            label: online ? 'Cash on delivery and online' : 'Cash on delivery',
            detail: online ? 'Card, UPI or netbanking' : 'Only method for now',
          ),
        ]),
        const _Head('Appearance'),
        SizedBox(
          width: double.infinity,
          child: SegmentedButton<ThemeMode>(
            showSelectedIcon: false,
            segments: const [
              ButtonSegment(value: ThemeMode.system, label: Text('System'), icon: Icon(Icons.brightness_auto_rounded)),
              ButtonSegment(value: ThemeMode.light, label: Text('Light'), icon: Icon(Icons.light_mode_rounded)),
              ButtonSegment(value: ThemeMode.dark, label: Text('Dark'), icon: Icon(Icons.dark_mode_rounded)),
            ],
            selected: {mode},
            onSelectionChanged: (s) => ref.read(themeModeProvider.notifier).set(s.first),
            style: SegmentedButton.styleFrom(
              minimumSize: const Size(0, 46),
              selectedBackgroundColor: c.accentSoft,
              selectedForegroundColor: c.accentInk,
              side: BorderSide(color: c.line),
            ),
          ),
        ),
        const _Head('Other'),
        _Group(children: [
          _Row(
            icon: Icons.help_outline_rounded,
            tone: c.green,
            label: 'Help & support',
            onTap: () => context.push('/profile/help'),
          ),
          _Row(
            icon: Icons.info_outline_rounded,
            tone: c.blue,
            label: 'About Deligro',
            onTap: () => context.push('/profile/about'),
          ),
          _Row(
            icon: Icons.code_rounded,
            tone: c.deal,
            label: 'Contact developers',
            onTap: () => _contactDeveloper(context),
          ),
        ]),
        const SizedBox(height: 24),
        OutlinedButton.icon(
          onPressed: () => _signOut(context, ref),
          style: OutlinedButton.styleFrom(foregroundColor: c.deal),
          icon: const Icon(Icons.logout_rounded, size: 18),
          label: const Text('Sign out'),
        ),
        const SizedBox(height: 20),
        Text('Deligro · Phoxera Solutions Private Limited',
            textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: c.muted)),
      ],
    );
  }

  Future<void> _editName(BuildContext context, WidgetRef ref, String? current) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _EditNameSheet(initial: current ?? ''),
    );
    if (saved == true && context.mounted) showSnack(context, 'Name updated');
  }

  Future<void> _signOut(BuildContext context, WidgetRef ref) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text('You\'ll need a new code on your phone to sign back in.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            style: FilledButton.styleFrom(minimumSize: const Size(48, 44)),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(accountRepoProvider).signOut();
      // The router's redirect takes it from here (to /login).
    } catch (_) {
      if (context.mounted) showSnack(context, 'Couldn\'t sign out. Try again.');
    }
  }
}

class _EditNameSheet extends ConsumerStatefulWidget {
  const _EditNameSheet({required this.initial});
  final String initial;

  @override
  ConsumerState<_EditNameSheet> createState() => _EditNameSheetState();
}

class _EditNameSheetState extends ConsumerState<_EditNameSheet> {
  late final _name = TextEditingController(text: widget.initial);
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _name.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  bool get _valid => _name.text.trim().length >= 2;

  Future<void> _save() async {
    if (!_valid || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(accountRepoProvider).updateName(_name.text.trim());
      ref.invalidate(profileProvider);
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.friendly);
    } catch (_) {
      if (mounted) setState(() => _error = 'Couldn\'t save. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Your name', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 4),
          Text('Riders and restaurants see this on your order.', style: TextStyle(color: c.muted, fontSize: 13)),
          const SizedBox(height: 16),
          TextField(
            controller: _name,
            autofocus: true,
            maxLength: 60,
            textCapitalization: TextCapitalization.words,
            autofillHints: const [AutofillHints.name],
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _save(),
            decoration: InputDecoration(hintText: 'Full name', errorText: _error),
          ),
          const SizedBox(height: 8),
          FilledButton(
            onPressed: _valid && !_busy ? _save : null,
            child: _busy
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Save'),
          ),
        ],
      ),
    );
  }
}

class _Head extends StatelessWidget {
  const _Head(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 26, bottom: 8, left: 2),
        child: Text(text.toUpperCase(),
            style: TextStyle(
                fontSize: 12.5, fontWeight: FontWeight.w800, letterSpacing: .8, color: context.colors.muted)),
      );
}

class _Group extends StatelessWidget {
  const _Group({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Material(
        color: context.colors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusBlock),
          side: BorderSide(color: context.colors.line),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            for (var i = 0; i < children.length; i++) ...[
              if (i > 0) const Divider(height: 1, indent: 62),
              children[i],
            ],
          ],
        ),
      );
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.tone, required this.label, this.detail, this.onTap});
  final IconData icon;
  final Color tone;
  final String label;
  final String? detail;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      onTap: onTap,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 56),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(color: tone.withValues(alpha: .13), borderRadius: BorderRadius.circular(10)),
                child: Icon(icon, size: 19, color: tone),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                    if (detail != null)
                      Text(detail!, style: TextStyle(fontSize: 12.5, color: c.muted)),
                  ],
                ),
              ),
              if (onTap != null) Icon(Icons.chevron_right_rounded, color: c.muted),
            ],
          ),
        ),
      ),
    );
  }
}
