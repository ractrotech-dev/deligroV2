import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../models/rider_me.dart';
import '../../state/availability.dart';
import '../../theme/app_theme.dart';

/// The centrepiece of Home: whether the rider is taking orders, in one glance
/// and one thumb. A big Online/Offline switch, a chip that says exactly where
/// the shift stands, the break menu while online, and the time online.
class AvailabilityCard extends ConsumerStatefulWidget {
  const AvailabilityCard({super.key});

  @override
  ConsumerState<AvailabilityCard> createState() => _AvailabilityCardState();
}

class _AvailabilityCardState extends ConsumerState<AvailabilityCard> {
  bool _busy = false;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    // The chip and the time online follow the clock: a break running out, a
    // fix going stale.
    _tick = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await action();
    } catch (e) {
      if (mounted) _showError(e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _showError(Object e) {
    final String text;
    if (e is ApiException && e.code == 'active_delivery') {
      text = 'Finish or hand back your current order first.';
    } else if (e is ApiException &&
        (e.status == 503 || e.code == 'migration_pending')) {
      text = "Online status isn't available yet — Deligro is updating.";
    } else if (e is ApiException) {
      text = e.friendly;
    } else {
      text = 'Something went wrong. Please try again.';
    }
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _chooseBreak() async {
    final choice = await showModalBottomSheet<({int? minutes})>(
      context: context,
      useRootNavigator: true,
      isScrollControlled: true,
      builder: (_) => const _BreakSheet(),
    );
    if (choice == null || !mounted) return;
    await _run(
      () => ref.read(availabilityProvider.notifier).takeBreak(choice.minutes),
    );
  }

  @override
  Widget build(BuildContext context) {
    final a = ref.watch(availabilityProvider);
    final now = DateTime.now();
    final phase = phaseOf(a, now);
    final online = phase != RiderPhase.offline;
    final c = context.colors;
    final notifier = ref.read(availabilityProvider.notifier);

    final title = switch (phase) {
      RiderPhase.offline => "You're offline",
      RiderPhase.onBreak => "You're on a break",
      _ => "You're online",
    };
    final hint = switch (phase) {
      RiderPhase.offline => 'Go online to start getting orders.',
      RiderPhase.onBreak => 'No new orders while you are on a break.',
      RiderPhase.stale => "We're waiting for your phone's location. Orders reach you once it arrives.",
      RiderPhase.online => 'You can get orders now.',
    };

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusSheet),
        border: Border.all(
          color: online ? c.green : c.line,
          width: online ? 2.5 : 1.5,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: AlignmentDirectional.centerStart,
            child: PhaseChip(phase: phase, availability: a),
          ),
          const SizedBox(height: 14),
          Semantics(
            liveRegion: true,
            child: Text(
              title,
              style: const TextStyle(
                fontSize: 30,
                fontWeight: FontWeight.w900,
                letterSpacing: -0.6,
                height: 1.1,
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            hint,
            style: TextStyle(color: c.muted, fontSize: 15, height: 1.35),
          ),
          if (online && a.onlineSince != null) ...[
            const SizedBox(height: 12),
            _TimeOnline(since: a.onlineSince!, now: now),
          ],
          const SizedBox(height: 20),
          AvailabilitySwitch(
            online: online,
            busy: _busy,
            onChanged: () =>
                _run(online ? notifier.goOffline : notifier.goOnline),
          ),
          if (online) ...[
            const SizedBox(height: 12),
            if (phase == RiderPhase.onBreak)
              FilledButton.icon(
                key: const Key('resume-button'),
                onPressed: _busy ? null : () => _run(notifier.resume),
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(56),
                ),
                icon: const Icon(Icons.play_arrow_rounded),
                label: Text('Resume work'),
              )
            else
              OutlinedButton.icon(
                key: const Key('break-button'),
                onPressed: _busy ? null : _chooseBreak,
                style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(56),
                ),
                icon: const Icon(Icons.free_breakfast_outlined),
                label: Text('Take a break'),
              ),
          ],
        ],
      ),
    );
  }
}

/// "Online" · "On break until 3:45 pm" · "Offline" · "Waiting for location".
/// An icon and words, never colour alone. The phase is worked out from the
/// availability row at [now] by the card, not read from the server's word.
class PhaseChip extends StatelessWidget {
  const PhaseChip({super.key, required this.phase, required this.availability});

  final RiderPhase phase;
  final RiderAvailabilityDto availability;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (bg, fg, icon) = switch (phase) {
      RiderPhase.offline => (
        c.surface2,
        c.ink,
        Icons.power_settings_new_rounded,
      ),
      RiderPhase.online => (c.greenSoft, c.green, Icons.check_circle_rounded),
      RiderPhase.stale => (
        c.accentSoft,
        c.accentInk,
        Icons.location_searching_rounded,
      ),
      RiderPhase.onBreak => (c.pop, c.popInk, Icons.pause_circle_rounded),
    };
    final text = switch (phase) {
      RiderPhase.offline => 'Offline',
      RiderPhase.online => 'Online',
      RiderPhase.stale => 'Waiting for location',
      RiderPhase.onBreak => _breakText(availability.breakUntil),
    };
    return Container(
      key: const Key('phase-chip'),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 18, color: fg),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              text,
              style: TextStyle(
                color: fg,
                fontWeight: FontWeight.w800,
                fontSize: 14,
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _breakText(DateTime? until) {
    if (isUntilResumed(until)) {
      // Never a date: "until I resume" is stored as a break ending in year 9999.
      return 'On break · Until you resume';
    }
    final t = until == null
        ? ''
        : DateFormat('h:mm a').format(until.toLocal()).toLowerCase();
    return 'On break until $t';
  }
}

class _TimeOnline extends StatelessWidget {
  const _TimeOnline({required this.since, required this.now});

  final DateTime since;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final minutes = now.difference(since).inMinutes.clamp(0, 24 * 60 * 30);
    final h = minutes ~/ 60;
    final m = minutes % 60;
    final value = h == 0
        ? '$m min'
        : '$h h $m min';
    return Row(
      children: [
        Icon(Icons.timer_outlined, size: 18, color: c.muted),
        const SizedBox(width: 6),
        Text(
          'Time online',
          style: TextStyle(color: c.muted, fontSize: 14),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            value,
            style: dataStyle(context, size: 15, weight: FontWeight.w700),
          ),
        ),
      ],
    );
  }
}

/// The big switch: a 76 px pill the whole width of the card, with a thumb that
/// slides across. High contrast in both themes (solid green when online, an
/// outlined grey when not), and the whole pill is the tap target.
class AvailabilitySwitch extends StatelessWidget {
  const AvailabilitySwitch({
    super.key,
    required this.online,
    required this.busy,
    required this.onChanged,
  });

  final bool online;
  final bool busy;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final dark = Theme.of(context).brightness == Brightness.dark;
    final track = online ? c.green : c.surface2;
    final onGreen = dark ? const Color(0xFF04210F) : Colors.white;
    final onTrack = online ? onGreen : c.ink;
    final label = online
        ? 'ONLINE'
        : 'GO ONLINE';
    final semantic = online
        ? 'Go offline'
        : 'Go online';
    return Semantics(
      button: true,
      toggled: online,
      enabled: !busy,
      label: semantic,
      excludeSemantics: true,
      onTap: busy ? null : onChanged,
      child: Material(
        key: const Key('availability-switch'),
        color: track,
        shape: StadiumBorder(
          side: BorderSide(
            color: online ? c.green : c.ink.withValues(alpha: 0.35),
            width: 2,
          ),
        ),
        child: InkWell(
          customBorder: const StadiumBorder(),
          onTap: busy ? null : onChanged,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 76),
            child: Stack(
              alignment: Alignment.center,
              children: [
                Padding(
                  padding: EdgeInsetsDirectional.only(
                    start: online ? 20 : 84,
                    end: online ? 84 : 20,
                  ),
                  child: Text(
                    label,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: onTrack,
                      fontSize: 20,
                      fontWeight: FontWeight.w900,
                      letterSpacing: 0.4,
                    ),
                  ),
                ),
                Positioned.fill(
                  child: AnimatedAlign(
                    duration: const Duration(milliseconds: 180),
                    curve: Curves.easeOut,
                    alignment: online
                        ? AlignmentDirectional.centerEnd
                        : AlignmentDirectional.centerStart,
                    child: Padding(
                      padding: const EdgeInsets.all(8),
                      child: Container(
                        width: 60,
                        height: 60,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: online ? onGreen : c.ink,
                          shape: BoxShape.circle,
                        ),
                        child: busy
                            ? SizedBox(
                                width: 24,
                                height: 24,
                                child: CircularProgressIndicator(
                                  strokeWidth: 3,
                                  color: online ? c.green : c.bg,
                                ),
                              )
                            : Icon(
                                Icons.power_settings_new_rounded,
                                size: 30,
                                color: online ? c.green : c.bg,
                              ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _BreakSheet extends StatelessWidget {
  const _BreakSheet();

  @override
  Widget build(BuildContext context) {
    final options = <(String, int?, String)>[
      ('break-15', 15, '15 minutes'),
      ('break-30', 30, '30 minutes'),
      ('break-60', 60, '1 hour'),
      (
        'break-until-resume',
        null,
        'Until I resume',
      ),
    ];
    return SafeArea(
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
              child: Text(
                'Take a break for',
                style: Theme.of(context).textTheme.titleLarge,
              ),
            ),
            for (final (key, minutes, label) in options)
              ListTile(
                key: Key(key),
                minTileHeight: 60,
                contentPadding: const EdgeInsets.symmetric(horizontal: 24),
                leading: Icon(
                  minutes == null
                      ? Icons.all_inclusive_rounded
                      : Icons.schedule_rounded,
                ),
                title: Text(
                  label,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                onTap: () => Navigator.pop(context, (minutes: minutes)),
              ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }
}
