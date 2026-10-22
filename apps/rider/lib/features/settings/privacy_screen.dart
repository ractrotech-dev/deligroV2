import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart' show showSnack;
import '../../widgets/rows.dart';

/// One thing the Rider app holds about the rider.
class _Held {
  const _Held(this.icon, this.title, this.body, this.who, this.howLong);

  final IconData icon;
  final String title;
  final String body;
  final String who;
  final String howLong;
}

/// Privacy & data.
///
/// Modelled on the customer web page (`/profile/privacy`): a plain description
/// of what the app does, field by field, not a policy document. Deligro has no
/// published privacy policy or terms, and inventing legal text to fill a screen
/// would be worse than leaving it out. Everything below can be checked against
/// the schema and the `/api/rider/*` routes. The policy and terms rows appear
/// only when the server sends a link (`me.privacyUrl` / `me.termsUrl`).
const _held = <_Held>[
  _Held(
    Icons.smartphone_rounded,
    'Your phone number',
    'It is how you sign in and how Deligro reaches you.',
    'You and Deligro staff.',
    'For as long as your rider account exists.',
  ),
  _Held(
    Icons.badge_outlined,
    'Your name and photo',
    'The name and profile photo on your account, so Deligro staff know who is riding.',
    'You and Deligro staff.',
    'For as long as your rider account exists.',
  ),
  _Held(
    Icons.location_on_outlined,
    'Your location',
    "Your phone's position, only while you are online. When you go offline, new positions are dropped, not kept.",
    'Deligro ops and staff. During a delivery, the customer sees where you are on their map.',
    "Only your latest position is kept, and the next one replaces it. Positions noted at delivery steps (accepted, picked up, delivered) stay with that delivery's record.",
  ),
  _Held(
    Icons.local_shipping_outlined,
    'Delivery records',
    'Orders offered to you, and what you did with each: accepted, picked up, delivered or handed back, with times.',
    'You and Deligro staff.',
    'Kept. They are the record behind receipts, refunds and payouts, so they are not cleared.',
  ),
  _Held(
    Icons.payments_outlined,
    'Earnings and cash records',
    'What you earned, the cash you collected from customers, what you handed over, and expenses you claimed.',
    'You, and the Deligro staff who handle payouts.',
    'Kept as financial records. They are not cleared.',
  ),
  _Held(
    Icons.description_outlined,
    'Documents',
    'Any documents Deligro asks you for to verify you as a rider.',
    'Deligro staff.',
    'While you ride for Deligro. Ask Deligro support if you want them removed.',
  ),
];

class PrivacyScreen extends ConsumerWidget {
  const PrivacyScreen({super.key});

  Future<void> _open(BuildContext context, String url) async {
    var opened = false;
    try {
      opened = await launchUrl(
        Uri.parse(url),
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {
      opened = false;
    }
    if (!opened && context.mounted) {
      showSnack(context, "Couldn't open that link.");
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final me = ref.watch(meProvider).value;
    final privacyUrl = (me?.privacyUrl ?? '').trim();
    final termsUrl = (me?.termsUrl ?? '').trim();

    return Scaffold(
      appBar: AppBar(title: const Text('Privacy & data')),
      body: SafeArea(
        bottom: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const RowsLabel('What the Rider app holds'),
              Container(
                decoration: BoxDecoration(
                  color: c.surface,
                  borderRadius: BorderRadius.circular(radiusBlock),
                  border: Border.all(color: c.line),
                ),
                child: Column(
                  children: [
                    for (var i = 0; i < _held.length; i++) ...[
                      if (i > 0) const Divider(),
                      _HeldRow(held: _held[i]),
                    ],
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
                child: Text(
                  'This page describes what the app does. It is a plain list, not a legal document. To ask for your profile to be removed, ask Deligro support.',
                  style: TextStyle(color: c.muted, fontSize: 12.5, height: 1.45),
                ),
              ),
              if (privacyUrl.isNotEmpty || termsUrl.isNotEmpty) ...[
                const RowsLabel('Policies'),
                RowsCard(
                  children: [
                    if (privacyUrl.isNotEmpty)
                      NavRow(
                        key: const Key('row-privacy-policy'),
                        icon: Icons.policy_outlined,
                        title: 'Privacy policy',
                        trailing: Icon(
                          Icons.open_in_new_rounded,
                          size: 20,
                          color: c.muted,
                        ),
                        onTap: () => _open(context, privacyUrl),
                      ),
                    if (termsUrl.isNotEmpty)
                      NavRow(
                        key: const Key('row-terms'),
                        icon: Icons.gavel_rounded,
                        title: 'Terms',
                        trailing: Icon(
                          Icons.open_in_new_rounded,
                          size: 20,
                          color: c.muted,
                        ),
                        onTap: () => _open(context, termsUrl),
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _HeldRow extends StatelessWidget {
  const _HeldRow({required this.held});

  final _Held held;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget fact(String label, String text) => Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '$label ',
              style: TextStyle(color: c.ink, fontWeight: FontWeight.w700),
            ),
            TextSpan(text: text),
          ],
        ),
        style: TextStyle(color: c.muted, fontSize: 13, height: 1.4),
      ),
    );
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: c.surface2,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(held.icon, size: 18, color: c.muted),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  held.title,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  held.body,
                  style: TextStyle(color: c.muted, fontSize: 13, height: 1.4),
                ),
                fact('Who can see it:', held.who),
                fact('How long:', held.howLong),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
