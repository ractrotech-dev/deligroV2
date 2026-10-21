import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/account_repository.dart';

/// Offers (or, below the minimum, requires) the Partner APK the admin
/// published. A forced update can't be dismissed; an optional one can.
Future<void> showUpdatePrompt(BuildContext context, AppVersion v, {required bool hi}) async {
  if (!v.updateAvailable || v.apkUrl.isEmpty || !context.mounted) return;
  String t(String en, String hin) => hi ? hin : en;
  await showDialog<void>(
    context: context,
    barrierDismissible: !v.forceUpdate,
    builder: (dialog) => PopScope(
      canPop: !v.forceUpdate,
      child: AlertDialog(
        title: Text(v.forceUpdate ? t('Update required', 'अपडेट ज़रूरी है') : t('Update available', 'नया अपडेट')),
        content: Text(v.notes.isNotEmpty
            ? v.notes
            : t('A new version of Deligro Partner is ready. Update to keep taking orders smoothly.',
                'Deligro पार्टनर का नया वर्ज़न आ गया है। ऑर्डर आसानी से लेते रहने के लिए अपडेट करें।')),
        actions: [
          if (!v.forceUpdate)
            TextButton(onPressed: () => Navigator.pop(dialog), child: Text(t('Later', 'बाद में'))),
          FilledButton(
            onPressed: () => launchUrl(Uri.parse(v.apkUrl), mode: LaunchMode.externalApplication),
            child: Text(t('Update', 'अपडेट करें')),
          ),
        ],
      ),
    ),
  );
}
