import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/inbox.dart';
import '../../state/support.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart' show showSnack;
import '../../widgets/rows.dart';

/// One switch per notification category. Offers, cancellations and safety are
/// on for good and say why; the rest save to the server, which is what decides
/// whether a push is sent. A mute stops the push only: the notification is
/// still in the inbox.
class NotificationSwitches extends ConsumerWidget {
  const NotificationSwitches({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final prefs = ref.watch(notificationPrefsProvider);
    final c = context.colors;
    return RowsCard(
      children: [
        for (final cat in notificationCategories)
          _SwitchRow(
            category: cat,
            on: prefs.isOn(cat.key),
            onChanged: cat.locked
                ? null
                : (v) async {
                    final saved = await ref.read(notificationPrefsProvider.notifier).set(cat.key, v);
                    if (!saved && context.mounted) {
                      showSnack(context, "Couldn't save that. Check your connection and try again.");
                    }
                  },
            mutedHint: c.muted,
          ),
      ],
    );
  }
}

class _SwitchRow extends StatelessWidget {
  const _SwitchRow({
    required this.category,
    required this.on,
    required this.onChanged,
    required this.mutedHint,
  });

  final NotificationCategory category;
  final bool on;
  final ValueChanged<bool>? onChanged;
  final Color mutedHint;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 56),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    category.title,
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
                  ),
                  const SizedBox(height: 2),
                  Text(category.hint, style: TextStyle(color: mutedHint, fontSize: 13, height: 1.3)),
                ],
              ),
            ),
            const SizedBox(width: 8),
            if (category.locked) Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Icon(Icons.lock_outline_rounded, size: 18, color: mutedHint),
            ),
            Switch(
              key: Key('notif-${category.key}'),
              value: on,
              onChanged: onChanged,
            ),
          ],
        ),
      ),
    );
  }
}
