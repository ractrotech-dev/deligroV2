import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// About Deligro (app/(customer)/profile/about) with the plain-words privacy
/// summary from profile/privacy.
class AboutScreen extends StatelessWidget {
  const AboutScreen({super.key});

  static const _version = '2.0.0 (2)';

  static const _held = [
    (
      icon: Icons.smartphone_rounded,
      title: 'Your phone number',
      body: 'It is how you sign in and how a rider reaches you at the door. It is the one thing an '
          'account cannot exist without.',
    ),
    (
      icon: Icons.location_on_outlined,
      title: 'Addresses you save',
      body: 'The label, the address line and its map pin, so a rider can find you. Saved only when '
          'you add one, and yours to delete at any time.',
    ),
    (
      icon: Icons.receipt_long_outlined,
      title: 'Your orders',
      body: 'What you ordered, from where, what it cost and how it was paid. This is the record behind '
          'your receipts and any refund, so it is kept rather than cleared.',
    ),
    (
      icon: Icons.key_outlined,
      title: 'A device token for notifications',
      body: 'Only if you allow notifications. It identifies this device to the notification service — '
          'not you.',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final body = TextStyle(fontSize: 15, height: 1.55, color: c.ink);
    final strong = const TextStyle(fontWeight: FontWeight.w700);

    Widget head(String t) => Padding(
          padding: const EdgeInsets.only(top: 26, bottom: 8, left: 2),
          child: Text(t.toUpperCase(),
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, letterSpacing: .8, color: c.muted)),
        );

    Widget fact(String k, String v) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 3),
          child: Text.rich(TextSpan(
            style: TextStyle(fontSize: 14, color: c.muted),
            children: [
              TextSpan(text: '$k  ', style: TextStyle(color: c.ink, fontWeight: FontWeight.w700)),
              TextSpan(text: v),
            ],
          )),
        );

    return Scaffold(
      appBar: AppBar(title: const Text('About Deligro')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
        children: [
          Center(
            child: Column(
              children: [
                Container(
                  width: 64,
                  height: 64,
                  decoration: BoxDecoration(color: c.accent, borderRadius: BorderRadius.circular(20)),
                  child: Icon(Icons.delivery_dining_rounded, size: 36, color: c.onAccent),
                ),
                const SizedBox(height: 10),
                Text.rich(TextSpan(
                  text: 'Deligro',
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.w900, letterSpacing: -0.8, color: c.ink),
                  children: [TextSpan(text: '.', style: TextStyle(color: c.accent))],
                )),
                Text('Version $_version', style: dataStyle(context, size: 12.5).copyWith(color: c.muted)),
              ],
            ),
          ),
          const SizedBox(height: 20),
          Panel(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text.rich(TextSpan(style: body, children: [
                  TextSpan(text: 'Deligro Delivery', style: strong),
                  const TextSpan(text: ' is a local food and grocery delivery platform developed by '),
                  TextSpan(text: 'Phoxera Solutions Private Limited', style: strong),
                  const TextSpan(
                    text: '. Operating in Bemetara only, Deligro connects you with nearby restaurants '
                        'and grocery stores for fast, reliable doorstep delivery.',
                  ),
                ])),
                const SizedBox(height: 12),
                Text(
                  'From hot, freshly cooked meals to everyday grocery essentials, order online and track '
                  'every delivery from store to your door — warm, fresh, and on time across Bemetara.',
                  style: body.copyWith(color: c.muted),
                ),
                const SizedBox(height: 14),
                fact('Version', _version),
                fact('Service area', 'Bemetara'),
                fact('Developed by', 'Phoxera Solutions Private Limited'),
              ],
            ),
          ),
          head('Privacy & security'),
          Panel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('A code to your phone, never a password',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                Text(
                  'Deligro has no password for your account, so there is none to guess, reuse or leak. '
                  'Each sign-in sends a one-time code to your number and that code expires.',
                  style: TextStyle(fontSize: 13.5, color: c.muted, height: 1.5),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          Panel(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                for (var i = 0; i < _held.length; i++) ...[
                  if (i > 0) const Divider(height: 1),
                  Padding(
                    padding: const EdgeInsets.all(14),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          width: 34,
                          height: 34,
                          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(10)),
                          child: Icon(_held[i].icon, size: 18, color: c.muted),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(_held[i].title, style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700)),
                              const SizedBox(height: 2),
                              Text(_held[i].body, style: TextStyle(fontSize: 13, color: c.muted, height: 1.45)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(2, 10, 2, 0),
            child: Text(
              'Your card details are never held here — online payments go straight to the payment provider, '
              'and Deligro only learns whether a payment succeeded. To delete your account, contact us: we '
              'remove your profile and addresses; past orders are kept as the record behind receipts and refunds.',
              style: TextStyle(fontSize: 12, color: c.muted, height: 1.5),
            ),
          ),
          head('Get in touch'),
          Panel(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                ListTile(
                  leading: Icon(Icons.help_outline_rounded, color: c.muted),
                  title: const Text('Help & support', style: TextStyle(fontWeight: FontWeight.w600)),
                  trailing: Icon(Icons.chevron_right_rounded, color: c.muted),
                  onTap: () => context.push('/profile/help'),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: Icon(Icons.mail_outline_rounded, color: c.muted),
                  title: const Text('Contact us', style: TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: const Text('support@deligro.app'),
                  trailing: Icon(Icons.open_in_new_rounded, size: 18, color: c.muted),
                  onTap: () async {
                    final ok = await launchUrl(Uri(scheme: 'mailto', path: 'support@deligro.app'));
                    if (!ok && context.mounted) showSnack(context, 'No email app found. Write to support@deligro.app');
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 22),
          Text('Deligro · Phoxera Solutions Private Limited',
              textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: c.muted)),
        ],
      ),
    );
  }
}
