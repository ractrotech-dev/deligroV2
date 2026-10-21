import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/i18n.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';

/// §15: who you are, where you work, what you may do, what you have done, and
/// where you are signed in.
class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final meAsync = ref.watch(managerMeProvider);
    final c = context.colors;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(tr(ref, 'Profile & permissions', 'प्रोफ़ाइल और अनुमतियाँ'))),
      body: AsyncView(
        value: meAsync,
        onRetry: () => ref.read(managerMeProvider.notifier).reload(),
        builder: (me) {
          if (me == null) return const SizedBox.shrink();
          final p = me.profile;
          final initials = p.displayName.trim().split(RegExp(r'\s+')).take(2).map((w) => w[0].toUpperCase()).join();
          return RefreshIndicator(
            onRefresh: () => ref.read(managerMeProvider.notifier).reload(),
            child: ListView(
              padding: const EdgeInsets.only(bottom: 24),
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
                  child: Row(
                    children: [
                      CircleAvatar(
                        radius: 28,
                        backgroundColor: c.accentSoft,
                        child: Text(initials, style: TextStyle(color: c.accentInk, fontWeight: FontWeight.w800, fontSize: 18)),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(p.displayName, style: TextStyle(fontSize: 19, fontWeight: FontWeight.w800, color: c.ink)),
                            const SizedBox(height: 4),
                            _RoleChip(admin: me.isAdmin),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                GroupLabel(tr(ref, 'Contact', 'संपर्क')),
                _Fact(icon: Icons.phone_outlined, label: tr(ref, 'Mobile', 'मोबाइल'), value: p.phone ?? '—'),
                _Fact(icon: Icons.mail_outline, label: tr(ref, 'Email', 'ईमेल'), value: p.email ?? '—'),
                GroupLabel(tr(ref, 'Zones', 'ज़ोन')),
                if (me.zones.all)
                  _Fact(icon: Icons.public, label: tr(ref, 'Access', 'एक्सेस'), value: tr(ref, 'Every zone (admin)', 'सभी ज़ोन (एडमिन)'))
                else if (me.hasNoZones)
                  const Padding(padding: EdgeInsets.symmetric(horizontal: 16), child: NoZonesNotice())
                else
                  for (final city in me.zones.cities)
                    _Fact(
                      icon: Icons.location_city_outlined,
                      label: city.name,
                      value: city.zones.map((z) => z.name).join(', '),
                    ),
                GroupLabel(tr(ref, 'Account', 'खाता')),
                _Link(
                  key: const Key('profile-permissions'),
                  icon: Icons.verified_user_outlined,
                  text: tr(ref, 'Permissions', 'अनुमतियाँ'),
                  sub: tr(ref, '${me.permissions.values.where((v) => v).length} of ${me.permissions.length} on',
                      '${me.permissions.length} में से ${me.permissions.values.where((v) => v).length} चालू'),
                  onTap: () => context.push('/more/profile/permissions'),
                ),
                _Link(
                  icon: Icons.history,
                  text: tr(ref, 'My activity', 'मेरी गतिविधि'),
                  onTap: () => context.push('/more/profile/activity'),
                ),
                _Link(
                  icon: Icons.devices_outlined,
                  text: tr(ref, 'Signed-in devices', 'साइन-इन डिवाइस'),
                  onTap: () => context.push('/more/profile/sessions'),
                ),
                _Link(
                  icon: Icons.password,
                  text: tr(ref, 'Change password', 'पासवर्ड बदलें'),
                  onTap: () => context.push('/more/profile/password'),
                ),
                _Link(
                  icon: Icons.notifications_outlined,
                  text: tr(ref, 'Notifications', 'सूचनाएँ'),
                  onTap: () => context.push('/more/profile/notifications'),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _RoleChip extends ConsumerWidget {
  const _RoleChip({required this.admin});
  final bool admin;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(color: admin ? c.greenSoft : c.accentSoft, borderRadius: BorderRadius.circular(999)),
      child: Text(
        admin ? tr(ref, 'Admin', 'एडमिन') : tr(ref, 'Manager', 'मैनेजर'),
        style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: admin ? c.green : c.accentInk),
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.icon, required this.label, required this.value});
  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListTile(
      leading: Icon(icon, color: c.muted),
      title: Text(label, style: TextStyle(fontSize: 12.5, color: c.muted)),
      subtitle: Text(value, style: TextStyle(fontSize: 15, color: c.ink, fontWeight: FontWeight.w600)),
    );
  }
}

class _Link extends StatelessWidget {
  const _Link({super.key, required this.icon, required this.text, this.sub, required this.onTap});
  final IconData icon;
  final String text;
  final String? sub;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return ListTile(
      minTileHeight: 56,
      leading: Icon(icon, color: c.ink),
      title: Text(text, style: TextStyle(fontWeight: FontWeight.w600, color: c.ink)),
      subtitle: sub == null ? null : Text(sub!, style: TextStyle(color: c.muted, fontSize: 12.5)),
      trailing: Icon(Icons.chevron_right, color: c.muted),
      onTap: onTap,
    );
  }
}
