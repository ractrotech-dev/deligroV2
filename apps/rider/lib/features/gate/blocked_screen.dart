import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/support.dart' show SupportContact;
import '../../state/prefs.dart';
import '../../state/providers.dart';
import '../../state/support.dart' show saveSupportContact;
import '../../theme/app_theme.dart';
import '../profile/document_upload_screen.dart';
import '../profile/document_viewer_screen.dart';
import '../profile/documents_screen.dart';
import '../safety/sos_sheet.dart' show SosActions;
import 'gate_widgets.dart';

const blockedPath = '/blocked';
const blockedDocumentsPath = '$blockedPath/documents';

/// Where a blocked rider may be: this screen and, when their registration was
/// rejected, their documents. A suspended rider's documents are refused by the
/// server, so that page is never opened for them.
String? blockedRedirect(String path, RiderBlockedException block) {
  if (path == blockedPath) return null;
  if (!block.suspended && path.startsWith(blockedDocumentsPath)) return null;
  return blockedPath;
}

/// The blocked screen and the document pages a rejected rider needs. Above the
/// tabs: nothing else in the app works for them.
final blockedRoute = GoRoute(
  path: blockedPath,
  builder: (_, _) => const BlockedScreen(),
  routes: [
    GoRoute(
      path: 'documents',
      builder: (_, _) => const DocumentsScreen(basePath: blockedDocumentsPath),
      routes: [
        GoRoute(
          path: 'upload/:type',
          builder: (_, state) => DocumentUploadScreen(type: state.pathParameters['type']!),
        ),
        GoRoute(
          path: 'view/:id',
          builder: (_, state) => DocumentViewerScreen(
            id: state.pathParameters['id']!,
            title: state.extra is String ? state.extra! as String : 'Document',
          ),
        ),
      ],
    ),
  ],
);

/// The words for a blocked rider. Says why, and what gets them working again.
({String title, String detail}) blockedText(RiderBlockedException block) {
  if (block.suspended) {
    return (
      title: 'Your account is suspended',
      detail: "You can't go online or take deliveries right now. Call Deligro support or your manager "
          'to find out why and what to do next.',
    );
  }
  final why = block.reason;
  return (
    title: 'Your registration was not approved',
    detail: [
      if (why != null) 'Deligro says: $why',
      "You can't take deliveries yet. Send your documents again below. Deligro checks them and can then "
          'approve you. Call Deligro support if you need help.',
    ].join('\n\n'),
  );
}

/// A rider Deligro has stopped from working (`/api/rider/me` → 403
/// `account_suspended` or `verification_rejected`). They are told why and how
/// to fix it, a rejected rider can send documents again, and an emergency still
/// works: Call 112 and Alert Deligro are on the page, not behind a button.
class BlockedScreen extends ConsumerStatefulWidget {
  const BlockedScreen({super.key});

  @override
  ConsumerState<BlockedScreen> createState() => _BlockedScreenState();
}

class _BlockedScreenState extends ConsumerState<BlockedScreen> {
  SupportContact? _kept;

  @override
  Widget build(BuildContext context) {
    final error = ref.watch(meProvider).error;
    // The router is on its way elsewhere; nothing to say for a frame.
    if (error is! RiderBlockedException) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    final contact = SupportContact.fromJson(error.body['contact']);
    if (_kept == null) {
      _kept = contact;
      // For the next time there is no signal.
      saveSupportContact(ref.read(prefsProvider), contact);
    }
    final text = blockedText(error);
    final c = context.colors;
    return GateMessage(
      key: const Key('blocked-screen'),
      icon: error.suspended ? Icons.block_rounded : Icons.description_outlined,
      message: text.title,
      detail: text.detail,
      actions: [
        if (!error.suspended)
          FilledButton.icon(
            key: const Key('blocked-documents'),
            onPressed: () => context.push(blockedDocumentsPath),
            icon: const Icon(Icons.upload_file_rounded),
            label: const Text('Send documents again'),
          ),
        OutlinedButton(
          key: const Key('blocked-check-again'),
          style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(48)),
          onPressed: () => ref.invalidate(meProvider),
          child: const Text('Check again'),
        ),
        const SizedBox(height: 12),
        Text('Emergency help', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleMedium?.copyWith(color: c.ink)),
        const SizedBox(height: 4),
        SosActions(gated: true, support: contact),
        const SizedBox(height: 4),
        const GateSignOutButton(),
      ],
    );
  }
}
