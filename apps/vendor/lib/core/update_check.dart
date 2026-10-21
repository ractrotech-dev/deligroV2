import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/account_repository.dart';

/// Offers (or, below the minimum, requires) the Partner APK the admin
/// published. A forced update can't be dismissed; an optional one can.
Future<void> showUpdatePrompt(BuildContext context, AppVersion v) async {
  if (!v.updateAvailable || v.apkUrl.isEmpty || !context.mounted) return;
  await showDialog<void>(
    context: context,
    barrierDismissible: !v.forceUpdate,
    builder: (dialog) => PopScope(
      canPop: !v.forceUpdate,
      child: AlertDialog(
        title: Text(v.forceUpdate ? 'Update required' : 'Update available'),
        content: Text(
          v.notes.isNotEmpty
              ? v.notes
              : 'A new version of Deligro Partner is ready. Update to keep taking orders smoothly.',
        ),
        actions: [
          if (!v.forceUpdate) TextButton(onPressed: () => Navigator.pop(dialog), child: const Text('Later')),
          FilledButton(
            onPressed: () => launchUrl(Uri.parse(v.apkUrl), mode: LaunchMode.externalApplication),
            child: const Text('Update'),
          ),
        ],
      ),
    ),
  );
}
