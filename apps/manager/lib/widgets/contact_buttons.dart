import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import 'async_view.dart';

/// Hands a URL to the phone (dialler, WhatsApp, a PDF viewer). One seam so
/// tests can see what would have been opened.
final urlOpenerProvider = Provider<Future<bool> Function(Uri)>(
  (_) => (uri) => launchUrl(uri, mode: LaunchMode.externalApplication),
);

/// `+91…` digits for wa.me (no plus, no spaces); a bare 10-digit Indian
/// number gets the 91 prefix.
String whatsappNumber(String phone) {
  final digits = phone.replaceAll(RegExp(r'\D'), '');
  return digits.length == 10 ? '91$digits' : digits;
}

/// Call and WhatsApp buttons for one number (§4.14 "contact vendors").
class ContactButtons extends ConsumerWidget {
  const ContactButtons({super.key, required this.phone, this.whatsapp = true});
  final String phone;
  final bool whatsapp;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final open = ref.read(urlOpenerProvider);
    Future<void> go(Uri u) async {
      final ok = await open(u);
      if (!ok && context.mounted) showSnack(context, "Couldn't open that on this phone.");
    }

    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        FilledButton.tonalIcon(
          key: const Key('contact-call'),
          onPressed: () => go(Uri(scheme: 'tel', path: phone)),
          icon: const Icon(Icons.call_outlined, size: 18),
          label: const Text('Call'),
        ),
        if (whatsapp)
          OutlinedButton.icon(
            key: const Key('contact-whatsapp'),
            onPressed: () => go(Uri.parse('https://wa.me/${whatsappNumber(phone)}')),
            icon: const Icon(Icons.chat_outlined, size: 18),
            label: const Text('WhatsApp'),
          ),
      ],
    );
  }
}
