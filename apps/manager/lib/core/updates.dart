import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/account.dart';

/// The update prompt for `/api/app-version?app=manager`. A forced update
/// cannot be dismissed; an optional one offers Later.
Future<void> showUpdateDialog(BuildContext context, AppVersionInfo v) => showDialog<void>(
      context: context,
      barrierDismissible: !v.forceUpdate,
      builder: (dialog) => PopScope(
        canPop: !v.forceUpdate,
        child: AlertDialog(
          title: Text(v.forceUpdate ? 'Update required' : 'Update available'),
          content: Text(v.notes.isNotEmpty
              ? v.notes
              : 'A new version of Deligro Manager is ready.${v.apkUrl.isEmpty ? ' Ask the office for the link.' : ''}'),
          actions: [
            if (!v.forceUpdate)
              TextButton(onPressed: () => Navigator.pop(dialog), child: const Text('Later')),
            if (v.apkUrl.isNotEmpty)
              FilledButton(
                onPressed: () => launchUrl(Uri.parse(v.apkUrl), mode: LaunchMode.externalApplication),
                child: const Text('Update'),
              ),
          ],
        ),
      ),
    );
