import 'package:flutter/material.dart';

import '../../models/profile.dart';
import '../../theme/app_theme.dart';

enum ChipTone { good, warn, bad, quiet }

/// A small coloured label: "Verified", "Expired", "Waiting for Deligro".
class StatusChip extends StatelessWidget {
  const StatusChip(this.label, {super.key, this.tone = ChipTone.quiet, this.icon});

  final String label;
  final ChipTone tone;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (bg, fg) = switch (tone) {
      ChipTone.good => (c.greenSoft, c.green),
      ChipTone.warn => (c.accentSoft, c.accentInk),
      ChipTone.bad => (c.dealSoft, c.deal),
      ChipTone.quiet => (c.surface2, c.muted),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(8)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[Icon(icon, size: 14, color: fg), const SizedBox(width: 4)],
          Flexible(
            child: Text(
              label,
              style: TextStyle(color: fg, fontSize: 12, fontWeight: FontWeight.w800),
            ),
          ),
        ],
      ),
    );
  }
}

ChipTone toneOf(Verification v) => switch (v) {
  Verification.verified => ChipTone.good,
  Verification.pending => ChipTone.warn,
  Verification.rejected => ChipTone.bad,
  Verification.unverified => ChipTone.quiet,
};

/// The rider's verification state, small enough for the Home header.
class VerificationBadge extends StatelessWidget {
  const VerificationBadge(this.status, {super.key});

  final Verification status;

  @override
  Widget build(BuildContext context) => StatusChip(
    status.label,
    tone: toneOf(status),
    icon: switch (status) {
      Verification.verified => Icons.verified_rounded,
      Verification.pending => Icons.hourglass_top_rounded,
      Verification.rejected => Icons.error_outline_rounded,
      Verification.unverified => Icons.shield_outlined,
    },
  );
}

/// "Expired 3 days ago", "Expires today", "Expires in 12 days" or
/// "Valid to 12 Dec 2026", from the days left the server counted.
({String text, ChipTone tone}) expiryLine(RiderDocument d, String Function(String? day) formatDay) {
  final days = d.daysLeft;
  if (d.expired) {
    final ago = days == null ? null : -days;
    return (
      text: ago == null || ago <= 0
          ? 'Expired'
          : 'Expired ${ago == 1 ? 'yesterday' : '$ago days ago'}',
      tone: ChipTone.bad,
    );
  }
  if (days == null) return (text: 'Valid to ${formatDay(d.expiresOn)}', tone: ChipTone.quiet);
  if (days == 0) return (text: 'Expires today', tone: ChipTone.bad);
  if (days <= 30) return (text: 'Expires in $days ${days == 1 ? 'day' : 'days'}', tone: ChipTone.warn);
  return (text: 'Valid to ${formatDay(d.expiresOn)}', tone: ChipTone.quiet);
}

/// One status for a document.
({String label, ChipTone tone}) docStatus(RiderDocument d) {
  if (d.expired) return (label: 'Expired', tone: ChipTone.bad);
  return switch (d.status) {
    'verified' => (label: 'Verified', tone: ChipTone.good),
    'rejected' => (label: 'Rejected', tone: ChipTone.bad),
    _ => (label: 'Waiting for Deligro', tone: ChipTone.warn),
  };
}
