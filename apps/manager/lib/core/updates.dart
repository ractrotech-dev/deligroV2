import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/account.dart';
import '../state/providers.dart';

/// Coming back to the front asks again at most this often (as the Rider app does).
const updateRecheckEvery = Duration(minutes: 15);

/// Where the router sends everything while a required update is pending.
const updateRequiredPath = '/update-required';

/// Whether [v] is one the app may not run past.
bool isBlocking(AppVersionInfo? v) => v != null && v.updateAvailable && v.forceUpdate;

/// `/api/app-version?app=manager` — admins publish the APK in Admin → Settings.
/// Null until it answers, and when the first check fails: an update prompt must
/// never block the app because the network did.
class UpdateCheck extends AsyncNotifier<AppVersionInfo?> {
  @override
  Future<AppVersionInfo?> build() => _ask();

  Future<AppVersionInfo?> _ask() async {
    try {
      return await ref.read(managerRepoProvider).appVersion();
    } catch (_) {
      return null;
    }
  }

  /// Ask again. An answer replaces the last one, so a required update published
  /// while the app was away now holds, and one the admin lifted lets go. No
  /// answer changes nothing: losing signal must not lift a required update.
  Future<void> recheck() async {
    final next = await _ask();
    if (next != null && ref.mounted) state = AsyncData(next);
  }

  /// An answer someone else already fetched (Settings → Check for updates).
  void adopt(AppVersionInfo v) => state = AsyncData(v);
}

final updateProvider = AsyncNotifierProvider<UpdateCheck, AppVersionInfo?>(UpdateCheck.new);

Future<void> _openApk(String url) async {
  try {
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  } catch (_) {
    // No browser to open the link in: the button simply does nothing.
  }
}

/// The prompt for an optional update, with Later.
Future<void> showUpdateDialog(BuildContext context, AppVersionInfo v) => showDialog<void>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Update available'),
        content: Text(v.notes.isNotEmpty
            ? v.notes
            : 'A new version of Deligro Manager is ready.${v.apkUrl.isEmpty ? ' Ask the office for the link.' : ''}'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog), child: const Text('Later')),
          if (v.apkUrl.isNotEmpty) FilledButton(onPressed: () => _openApk(v.apkUrl), child: const Text('Update')),
        ],
      ),
    );

/// The required-update screen: full screen, with no way out but updating.
class UpdateRequiredScreen extends ConsumerWidget {
  const UpdateRequiredScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final v = ref.watch(updateProvider).value;
    return PopScope(
      // Android Back must neither pop nor leave the app.
      canPop: false,
      child: Scaffold(
        key: const Key('update-required'),
        body: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: v == null
                  ? const CircularProgressIndicator()
                  : Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text('Update required', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge),
                          const SizedBox(height: 8),
                          Flexible(
                            child: SingleChildScrollView(
                              child: Text(
                                v.notes.isNotEmpty ? v.notes : 'This version of Deligro Manager is too old to keep running. Please update.',
                                textAlign: TextAlign.center,
                              ),
                            ),
                          ),
                          const SizedBox(height: 20),
                          if (v.apkUrl.isNotEmpty)
                            FilledButton(
                              key: const Key('update-download'),
                              onPressed: () => _openApk(v.apkUrl),
                              child: const Text('Update'),
                            )
                          else
                            const Text('Ask the office for the link.', textAlign: TextAlign.center),
                        ],
                      ),
                    ),
            ),
          ),
        ),
      ),
    );
  }
}
