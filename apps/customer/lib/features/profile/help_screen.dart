import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../models/settings.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

const _fallbackEmail = 'support@deligro.app';

String _digits(String s) => s.replaceAll(RegExp(r'\D'), '');

/// `shortOrderId` in order-map.ts.
String _shortId(String id) => id.length <= 12 ? id : id.substring(0, 8).toUpperCase();

/// Help & support (app/(customer)/profile/help). With [orderId], the contact
/// links carry the order number so support doesn't have to ask for it.
class HelpScreen extends ConsumerWidget {
  const HelpScreen({super.key, this.orderId});
  final String? orderId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final s = ref.watch(settingsProvider).value ?? PlatformSettings.defaults;
    final ref_ = orderId == null || orderId!.isEmpty ? null : _shortId(orderId!);
    final prefill = ref_ == null ? null : 'Hi, I need help with Order $ref_';

    final faq = [
      (
        q: 'Where is my order?',
        a: 'Open Orders and tap your active order to see live tracking on the map.',
      ),
      (
        q: 'How do I cancel?',
        a: 'You can cancel from the order tracking screen before the kitchen starts preparing your food.',
      ),
      (
        q: 'Payment methods',
        a: s.featureOnlinePayment
            ? 'You can pay cash on delivery, or online by card, UPI or netbanking at checkout. '
                'Some shops set a cash limit on larger orders — checkout will say so.'
            : 'We currently accept Cash on Delivery. Online payment isn\'t available yet.',
      ),
    ];

    final email = s.supportEmail.trim().isNotEmpty ? s.supportEmail.trim() : _fallbackEmail;
    final channels = [
      if (_digits(s.supportPhone).isNotEmpty)
        (
          icon: Icons.call_rounded,
          tone: c.blue,
          label: 'Call us',
          value: s.supportPhone,
          uri: Uri(scheme: 'tel', path: s.supportPhone.replaceAll(RegExp(r'[^\d+]'), '')),
        ),
      if (_digits(s.supportWhatsapp).isNotEmpty)
        (
          icon: Icons.chat_rounded,
          tone: c.green,
          label: 'WhatsApp',
          value: s.supportWhatsapp,
          uri: Uri.https('wa.me', '/${_digits(s.supportWhatsapp)}', prefill == null ? null : {'text': prefill}),
        ),
      (
        icon: Icons.mail_outline_rounded,
        tone: c.accent,
        label: 'Email',
        value: email,
        uri: Uri(
          scheme: 'mailto',
          path: email,
          query: prefill == null ? null : 'subject=${Uri.encodeComponent('Order $ref_')}',
        ),
      ),
    ];

    return Scaffold(
      appBar: AppBar(title: const Text('Help & support')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
        children: [
          if (ref_ != null)
            Container(
              margin: const EdgeInsets.only(bottom: 14),
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(radiusBlock)),
              child: Row(
                children: [
                  Icon(Icons.receipt_long_rounded, color: c.accentInk, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text.rich(TextSpan(
                      text: 'Getting help with ',
                      style: TextStyle(color: c.ink, fontSize: 14),
                      children: [
                        TextSpan(
                          text: 'Order $ref_',
                          style: dataStyle(context, size: 14, weight: FontWeight.w800),
                        ),
                        const TextSpan(text: '. We\'ll include it when you contact us.'),
                      ],
                    )),
                  ),
                ],
              ),
            ),
          Material(
            color: c.surface,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(radiusBlock),
              side: BorderSide(color: c.line),
            ),
            clipBehavior: Clip.antiAlias,
            child: Column(
              children: [
                for (var i = 0; i < faq.length; i++) ...[
                  if (i > 0) const Divider(height: 1),
                  Theme(
                    // ExpansionTile draws its own dividers; the card has them.
                    data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                    child: ExpansionTile(
                      title: Text(faq[i].q, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                      childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                      expandedAlignment: Alignment.centerLeft,
                      iconColor: c.accentInk,
                      collapsedIconColor: c.muted,
                      children: [
                        Text(faq[i].a, style: TextStyle(color: c.muted, fontSize: 14, height: 1.5)),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 26, bottom: 8, left: 2),
            child: Text('CONTACT DELIGRO SUPPORT',
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w800, letterSpacing: .8, color: c.muted)),
          ),
          for (final ch in channels)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Material(
                color: c.surface,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(radiusBlock),
                  side: BorderSide(color: c.line),
                ),
                clipBehavior: Clip.antiAlias,
                child: InkWell(
                  onTap: () async {
                    final ok = await launchUrl(ch.uri, mode: LaunchMode.externalApplication);
                    if (!ok && context.mounted) showSnack(context, 'Couldn\'t open ${ch.label}.');
                  },
                  child: Padding(
                    padding: const EdgeInsets.all(14),
                    child: Row(
                      children: [
                        Container(
                          width: 38,
                          height: 38,
                          decoration: BoxDecoration(color: ch.tone.withValues(alpha: .13), shape: BoxShape.circle),
                          child: Icon(ch.icon, size: 18, color: ch.tone),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(ch.label, style: TextStyle(fontSize: 12, color: c.muted)),
                              Text(ch.value,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w700)),
                            ],
                          ),
                        ),
                        Icon(Icons.open_in_new_rounded, size: 18, color: c.muted),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          const SizedBox(height: 10),
          OutlinedButton(
            onPressed: () => context.go('/orders'),
            child: const Text('View my orders'),
          ),
        ],
      ),
    );
  }
}
