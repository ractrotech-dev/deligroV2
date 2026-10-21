import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api.dart';
import '../theme/app_theme.dart';

/// The small-caps label over a group of settings (Settings uses the same).
class SectionHeading extends StatelessWidget {
  const SectionHeading(this.text, {super.key, this.trailing});

  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 22, 12, 8),
      child: Row(
        children: [
          Expanded(
            child: Text(
              text.toUpperCase(),
              style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w700, letterSpacing: .4),
            ),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

/// A bordered block on the page background, like the dashboard tiles.
class Panel extends StatelessWidget {
  const Panel({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.tint});

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color? tint;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    // A Material, not a decorated box, so list tiles inside keep their ink.
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Material(
        color: tint ?? c.surface,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusBlock),
          side: BorderSide(color: c.line),
        ),
        child: Padding(padding: padding, child: child),
      ),
    );
  }
}

/// A label and its value, one row of a read-only panel.
class InfoRow extends StatelessWidget {
  const InfoRow({super.key, required this.icon, required this.label, required this.value});

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 19, color: c.muted),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: TextStyle(color: c.muted, fontSize: 12.5)),
                const SizedBox(height: 1),
                Text(value, style: const TextStyle(fontWeight: FontWeight.w600)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Runs a write, shows what happened in a snackbar, and says whether it worked.
Future<bool> runWrite(
  BuildContext context,
  WidgetRef ref,
  Future<void> Function() write, {
  String? done,
  String? doneHi,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    await write();
    if (done != null) messenger.showSnackBar(SnackBar(content: Text(done)));
    return true;
  } on ApiException catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(e.friendly())));
  } catch (_) {
    messenger.showSnackBar(SnackBar(content: Text('Something went wrong. Try again.')));
  }
  return false;
}

/// "Couldn't load" with a Retry, for a screen whose first load failed.
class LoadFailed extends ConsumerWidget {
  const LoadFailed({super.key, required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final msg = error is ApiException ? (error as ApiException).friendly() : 'Couldn\'t load. Check your connection.';
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.cloud_off_rounded, size: 40, color: c.muted),
            const SizedBox(height: 12),
            Text(
              msg,
              textAlign: TextAlign.center,
              style: TextStyle(color: c.muted),
            ),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRetry, child: Text('Retry')),
          ],
        ),
      ),
    );
  }
}

/// "09:30" → "9:30 AM".
String clock12(String? hhmm) {
  if (hhmm == null || hhmm.length < 5) return '';
  final h = int.tryParse(hhmm.substring(0, 2)) ?? 0;
  final m = hhmm.substring(3, 5);
  final h12 = h % 12 == 0 ? 12 : h % 12;
  return '$h12:$m ${h < 12 ? 'AM' : 'PM'}';
}

String hhmmOf(TimeOfDay t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

TimeOfDay? timeOf(String? hhmm) {
  if (hhmm == null || hhmm.length < 5) return null;
  return TimeOfDay(hour: int.tryParse(hhmm.substring(0, 2)) ?? 0, minute: int.tryParse(hhmm.substring(3, 5)) ?? 0);
}
