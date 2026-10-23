import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config/env.dart';
import '../state/providers.dart';
import '../theme/app_theme.dart';
import 'api.dart';

typedef AppUpdate = ({
  bool updateAvailable,
  bool forceUpdate,
  String apkUrl,
  String notes,
});

/// `/api/app-version` — admins publish the rider APK in Admin → Settings.
/// Null when the check fails: an update prompt must never block the app.
Future<AppUpdate?> fetchAppUpdate(ApiClient api) async {
  try {
    final res = await api.get(
      '/api/app-version',
      query: {'app': 'rider', 'versionCode': '${Env.versionCode}'},
    );
    return (
      updateAvailable: res['updateAvailable'] == true,
      forceUpdate: res['forceUpdate'] == true,
      apkUrl: '${res['apkUrl'] ?? ''}',
      notes: '${res['releaseNotes'] ?? ''}',
    );
  } catch (_) {
    return null;
  }
}

/// The launch check. Settings → Check for updates asks again by itself.
final updateProvider = FutureProvider<AppUpdate?>(
  (ref) => fetchAppUpdate(ref.watch(apiProvider)),
);

/// What the rider reads about a new build: notes, and the download link when
/// the office has published one. [onLater] is null for a forced update, which
/// has no way out but updating.
class UpdatePanel extends StatelessWidget {
  const UpdatePanel({super.key, required this.update, this.onLater});

  final AppUpdate update;
  final VoidCallback? onLater;

  Future<void> _download() async {
    try {
      await launchUrl(
        Uri.parse(update.apkUrl),
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {
      // No browser to open the link in: the button simply does nothing.
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final force = update.forceUpdate;
    final notes = update.notes.trim();
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Container(
              width: 56,
              height: 56,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: c.accentSoft,
                shape: BoxShape.circle,
              ),
              child: Icon(
                Icons.system_update_alt_rounded,
                color: c.accentInk,
                size: 28,
              ),
            ),
            const SizedBox(height: 16),
            Text(
              force
                  ? 'Update required'
                  : 'Update available',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            Flexible(
              child: SingleChildScrollView(
                child: Text(
                  notes.isNotEmpty
                      ? notes
                      : force
                      ? 'This version of Deligro Rider is too old to keep running. Please update.'
                      : 'A new version of Deligro Rider is ready. Update to keep deliveries running smoothly.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: c.muted, fontSize: 15, height: 1.4),
                ),
              ),
            ),
            const SizedBox(height: 20),
            if (update.apkUrl.isNotEmpty)
              FilledButton(
                key: const Key('update-download'),
                onPressed: _download,
                child: Text('Update'),
              )
            else
              Text(
                'Ask Deligro support for the new version.',
                textAlign: TextAlign.center,
                style: TextStyle(color: c.ink, fontWeight: FontWeight.w700),
              ),
            if (onLater != null) ...[
              const SizedBox(height: 8),
              TextButton(
                key: const Key('update-later'),
                onPressed: onLater,
                style: TextButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                ),
                child: Text('Later'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// An optional update, as a sheet from the bottom. [context] must sit under a
/// Navigator.
Future<void> showUpdateSheet(BuildContext context, AppUpdate update) =>
    showModalBottomSheet<void>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      builder: (sheet) =>
          UpdatePanel(update: update, onLater: () => Navigator.pop(sheet)),
    );

/// Whether [update] is one the app may not run past.
bool isBlocking(AppUpdate? update) =>
    update != null && update.updateAvailable && update.forceUpdate;

/// Where the router sends everything while a forced update is pending. It is a
/// real route, not an overlay: the app underneath is not built at all, so Back,
/// deep links, TalkBack and the keyboard have nothing to reach.
const updateRequiredPath = '/update-required';

/// The forced-update screen: the update panel, full screen, with no way out.
class UpdateRequiredScreen extends ConsumerWidget {
  const UpdateRequiredScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final update = ref.watch(updateProvider).value;
    return PopScope(
      // Android Back must neither pop nor leave the app.
      canPop: false,
      child: Scaffold(
        key: const Key('update-blocker'),
        body: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: update == null
                ? const CircularProgressIndicator()
                : UpdatePanel(update: update),
          ),
        ),
      ),
    );
  }
}

/// Wraps the whole app (MaterialApp's `builder`). An optional update is offered
/// once per launch as a sheet. A forced one is the router's job
/// ([updateRequiredPath]).
class UpdateGate extends ConsumerStatefulWidget {
  const UpdateGate({
    super.key,
    required this.navigatorKey,
    required this.child,
  });

  final GlobalKey<NavigatorState> navigatorKey;
  final Widget child;

  @override
  ConsumerState<UpdateGate> createState() => _UpdateGateState();
}

class _UpdateGateState extends ConsumerState<UpdateGate> {
  bool _offered = false;

  void _offer(AppUpdate? update) {
    if (_offered || update == null) return;
    if (!update.updateAvailable || update.forceUpdate) return;
    _offered = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      // The overlay sits under the Navigator, so Navigator.of finds it.
      final ctx = widget.navigatorKey.currentState?.overlay?.context;
      if (!mounted || ctx == null || !ctx.mounted) return;
      showUpdateSheet(ctx, update);
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(updateProvider, (_, next) => _offer(next.value));
    return widget.child;
  }
}
