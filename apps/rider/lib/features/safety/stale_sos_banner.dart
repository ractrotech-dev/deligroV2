import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/sos_queue.dart';
import '../../state/safety.dart';
import '../../theme/app_theme.dart';
import 'sos_sheet.dart';

/// A small banner on Home while an SOS alert from over an hour ago is waiting
/// for the rider's word: it opens the SOS sheet, where it can be sent now or
/// discarded. Hidden otherwise, and when the alert queue cannot be read.
class StaleSosBanner extends ConsumerWidget {
  const StaleSosBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(sosStatusProvider).value;
    if (status == null || status.phase != SosPhase.stale) return const SizedBox.shrink();
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Material(
        color: c.pop,
        borderRadius: BorderRadius.circular(radiusBlock),
        child: InkWell(
          key: const Key('stale-sos-banner'),
          onTap: () => showSosSheet(context),
          borderRadius: BorderRadius.circular(radiusBlock),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 8, 12),
            child: Row(
              children: [
                Icon(Icons.history_toggle_off_rounded, color: c.popInk),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    sosStaleText,
                    style: TextStyle(color: c.popInk, fontWeight: FontWeight.w800, height: 1.3),
                  ),
                ),
                TextButton(
                  onPressed: () => showSosSheet(context),
                  style: TextButton.styleFrom(foregroundColor: c.popInk),
                  child: const Text('Review'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
