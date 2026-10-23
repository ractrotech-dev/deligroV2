import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/navigation_launcher.dart';
import '../../core/sos_queue.dart';
import '../../state/prefs.dart';
import '../../state/safety.dart';
import '../../state/support.dart';
import '../../state/providers.dart' show riderKeyProvider;
import '../../theme/app_theme.dart';
import '../../widgets/common.dart' show showSnack;

// The words of §15. Nothing here may say that emergency services were
// contacted: Call 112 is the phone's own call, and Alert Deligro reaches
// Deligro's staff only, and only once the server has said so.

/// Under "Call 112".
const call112Note = 'This calls 112 from your phone';

/// Under "Alert Deligro" when the phone has a current position.
const alertNote = 'Sends your location to Deligro ops';

/// Under "Alert Deligro" when it has none (no permission, no fix): the alert
/// still goes, without a location.
const noLocationNote = 'Location not available. Your alert still goes to Deligro ops.';

const locationCheckingNote = 'Checking your location…';

/// Shown only after the server has confirmed.
const sosSentText = 'Deligro ops have been alerted';

/// Shown while the server has not confirmed.
const sosQueuedText = 'Not sent yet — trying again';

const sosRefusedText = "Couldn't send the alert. Call Deligro support.";

/// A 401: nothing is retried until the rider is signed in again.
const sosSignInText = 'Not sent yet — sign in again to send it';

/// An alert from over an hour ago, kept but not sent.
const sosStaleText = 'An alert from over an hour ago has not been sent';

/// Where a rider with no emergency contact goes to add one (Profile, Phase 6).
const addContactPath = '/more/profile';

/// Opens the SOS options from the delivery screen.
Future<void> showSosSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    useSafeArea: true,
    builder: (_) => const SosSheet(),
  );
}

/// The small red SOS button for the delivery screen's header.
class SosButton extends StatelessWidget {
  const SosButton({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      button: true,
      label: 'SOS. Emergency help',
      child: FilledButton(
        key: const Key('sos-button'),
        onPressed: () => showSosSheet(context),
        style: FilledButton.styleFrom(
          backgroundColor: c.deal,
          foregroundColor: c.onDeal,
          minimumSize: const Size(52, 44),
          padding: const EdgeInsets.symmetric(horizontal: 14),
          textStyle: const TextStyle(fontWeight: FontWeight.w900, letterSpacing: 0.6, fontSize: 15),
        ),
        child: const Text('SOS'),
      ),
    );
  }
}

/// The SOS sheet: the four things a rider in trouble can do.
class SosSheet extends ConsumerWidget {
  const SosSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SafeArea(
      child: SingleChildScrollView(
        key: const Key('sos-sheet'),
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Emergency help', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 14),
            const SosActions(),
          ],
        ),
      ),
    );
  }
}

/// Call 112, Alert Deligro, call the emergency contact, call Deligro support.
/// Shared by the sheet and the Safety screen.
class SosActions extends ConsumerStatefulWidget {
  const SosActions({super.key, this.orderId});

  /// The order being carried, to tell ops which delivery this is.
  final String? orderId;

  @override
  ConsumerState<SosActions> createState() => _SosActionsState();
}

class _SosActionsState extends ConsumerState<SosActions> {
  @override
  void initState() {
    super.initState();
    // A finished alert from earlier is not news; one still waiting stays.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      ref.read(sosQueueProvider).reset();
      _checkLocation();
    });
  }

  Future<void> _call(String number, String failed) async {
    final uri = callUri(number);
    if (uri == null) return;
    final ok = await ref.read(urlOpenerProvider)(uri);
    if (!ok && mounted) showSnack(context, failed);
  }

  bool _tapped = false;

  /// Whether the phone has a current position: null while it is being read.
  bool? _hasPosition;

  // Reads the position once the sheet is up, so the words under Alert Deligro
  // say what will really be sent.
  void _checkLocation() {
    alertPosition(ref).then((p) {
      if (mounted) setState(() => _hasPosition = p != null);
    });
  }

  Future<void> _alert() async {
    final queue = ref.read(sosQueueProvider);
    if (_tapped || queue.current.phase == SosPhase.sending) return;
    setState(() => _tapped = true);
    try {
      // The alert is saved and shown as Sending at once; the queue asks for a
      // position itself, for a few seconds at most, and sends.
      await queue.alert(orderId: widget.orderId);
    } finally {
      if (mounted) setState(() => _tapped = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final status = ref.watch(sosStatusProvider).value ?? SosStatus.idle;
    final contact = ref.watch(emergencyContactProvider(ref.watch(riderKeyProvider))).value;
    final support = ref.watch(supportContactProvider(ref.watch(riderKeyProvider))).value ??
        savedSupportContact(ref.read(prefsProvider));
    final sending = _tapped || status.phase == SosPhase.sending;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FilledButton.icon(
          key: const Key('call-112'),
          onPressed: () => _call('112', "Couldn't open the phone app. Dial 112."),
          style: FilledButton.styleFrom(
            backgroundColor: c.deal,
            foregroundColor: c.onDeal,
            minimumSize: const Size.fromHeight(58),
          ),
          icon: const Icon(Icons.call_rounded),
          label: const Text('Call 112', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
        ),
        _Caption(call112Note),
        const SizedBox(height: 16),
        OutlinedButton.icon(
          key: const Key('alert-deligro'),
          onPressed: sending ? null : _alert,
          style: OutlinedButton.styleFrom(
            minimumSize: const Size.fromHeight(58),
            side: BorderSide(color: c.deal, width: 2),
            foregroundColor: c.deal,
          ),
          icon: sending
              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
              : const Icon(Icons.notifications_active_outlined),
          label: const Text('Alert Deligro', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
        ),
        _Caption(switch (_hasPosition) {
          null => locationCheckingNote,
          true => alertNote,
          false => noLocationNote,
        }),
        _AlertStatus(
          status: status,
          onSendNow: () => ref.read(sosQueueProvider).sendNow(),
          onDiscard: () => ref.read(sosQueueProvider).discard(),
        ),
        const SizedBox(height: 16),
        if (contact != null && contact.hasPhone) ...[
          OutlinedButton.icon(
            key: const Key('call-emergency-contact'),
            onPressed: () => _call(contact.phone!, "Couldn't open the phone app. Call ${contact.phone}."),
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(54)),
            icon: const Icon(Icons.person_outline_rounded),
            label: Text(
              contact.name == null ? 'Call my emergency contact' : 'Call ${contact.name}',
              overflow: TextOverflow.ellipsis,
            ),
          ),
          _Caption([contact.relation, contact.phone].whereType<String>().join(' · ')),
        ] else
          Container(
            key: const Key('no-emergency-contact'),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
            child: Row(
              children: [
                Icon(Icons.person_add_alt_1_outlined, color: c.muted),
                const SizedBox(width: 10),
                Expanded(
                  child: Text('No emergency contact saved', style: TextStyle(color: c.muted, fontWeight: FontWeight.w600)),
                ),
                TextButton(
                  key: const Key('add-emergency-contact'),
                  onPressed: () {
                    // Out of the sheet, then to the profile where it is added.
                    final router = GoRouter.of(context);
                    if (Navigator.of(context).canPop() && ModalRoute.of(context) is PopupRoute) {
                      Navigator.of(context).pop();
                    }
                    router.push(addContactPath);
                  },
                  child: const Text('Add one'),
                ),
              ],
            ),
          ),
        const SizedBox(height: 12),
        if (support.hasPhone)
          OutlinedButton.icon(
            key: const Key('call-support-sos'),
            onPressed: () => _call(support.phone!, "Couldn't open the phone app. Call ${support.phone}."),
            style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(54)),
            icon: const Icon(Icons.support_agent_rounded),
            label: const Text('Call Deligro support'),
          ),
      ],
    );
  }
}

class _Caption extends StatelessWidget {
  const _Caption(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 6, left: 4, right: 4),
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: TextStyle(color: context.colors.muted, fontSize: 13.5),
        ),
      );
}

/// What the alert has come to, in the words of §15: confirmed only when the
/// server said so.
class _AlertStatus extends StatelessWidget {
  const _AlertStatus({required this.status, required this.onSendNow, required this.onDiscard});

  final SosStatus status;
  final VoidCallback onSendNow;
  final VoidCallback onDiscard;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (key, text, icon, bg, fg) = switch (status.phase) {
      SosPhase.sent => ('sos-sent', sosSentText, Icons.check_circle_rounded, c.greenSoft, c.green),
      SosPhase.queued when status.needsSignIn =>
        ('sos-sign-in', sosSignInText, Icons.lock_outline_rounded, c.pop, c.popInk),
      SosPhase.queued => ('sos-queued', sosQueuedText, Icons.schedule_send_rounded, c.pop, c.popInk),
      SosPhase.stale => ('sos-stale', sosStaleText, Icons.history_toggle_off_rounded, c.pop, c.popInk),
      SosPhase.refused => ('sos-refused', sosRefusedText, Icons.error_outline_rounded, c.dealSoft, c.deal),
      _ => ('', '', Icons.circle, c.bg, c.ink),
    };
    if (text.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Semantics(
        liveRegion: true,
        child: Container(
          key: Key(key),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(radiusBlock)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(icon, color: fg),
                  const SizedBox(width: 10),
                  Expanded(child: Text(text, style: TextStyle(color: fg, fontWeight: FontWeight.w800, fontSize: 15.5))),
                ],
              ),
              if (status.phase == SosPhase.stale) ...[
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton(
                        key: const Key('sos-send-now'),
                        onPressed: onSendNow,
                        child: const Text('Send now'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: OutlinedButton(
                        key: const Key('sos-discard'),
                        onPressed: onDiscard,
                        style: OutlinedButton.styleFrom(foregroundColor: fg, side: BorderSide(color: fg)),
                        child: const Text('Discard'),
                      ),
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
