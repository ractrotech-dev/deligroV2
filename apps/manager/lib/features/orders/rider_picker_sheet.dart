import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../models/orders.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'order_labels.dart';

/// Picks a rider for an order (§3.14, §6.9): eligible riders first — nearest,
/// then least busy — each with distance, load and how fresh their location
/// is; ineligible ones greyed with the reason in words and not tappable. The
/// server re-checks eligibility when the assignment is sent.
Future<RiderCandidate?> showRiderPicker(BuildContext context, {required String orderId, required String title}) =>
    showModalBottomSheet<RiderCandidate>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _RiderPicker(orderId: orderId, title: title),
    );

String ineligibleText(IneligibleReason? r) => switch (r) {
      IneligibleReason.offline => 'Offline',
      IneligibleReason.onBreak => 'On a break',
      IneligibleReason.staleFix => 'No recent location',
      IneligibleReason.suspended => 'Suspended',
      IneligibleReason.outOfZone => 'Not in this zone',
      IneligibleReason.currentRider => 'Current rider',
      IneligibleReason.unknown || null => 'Not available',
    };

class _RiderPicker extends ConsumerStatefulWidget {
  const _RiderPicker({required this.orderId, required this.title});
  final String orderId;
  final String title;

  @override
  ConsumerState<_RiderPicker> createState() => _RiderPickerState();
}

class _RiderPickerState extends ConsumerState<_RiderPicker> {
  late Future<List<RiderCandidate>> _riders = _load();

  Future<List<RiderCandidate>> _load() => ref.read(ordersRepoProvider).riders(widget.orderId);

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(widget.title, style: Theme.of(context).textTheme.titleLarge),
            ),
            Flexible(
              child: FutureBuilder<List<RiderCandidate>>(
                future: _riders,
                builder: (context, snap) {
                  if (snap.hasError) {
                    return ErrorRetry(error: snap.error!, onRetry: () => setState(() => _riders = _load()));
                  }
                  final riders = snap.data;
                  if (riders == null) {
                    return const Padding(padding: EdgeInsets.all(32), child: Center(child: CircularProgressIndicator()));
                  }
                  if (riders.isEmpty) return const EmptyLine('No riders in this zone right now.');
                  final eligible = riders.where((r) => r.eligible).toList();
                  final others = riders.where((r) => !r.eligible).toList();
                  return ListView(
                    shrinkWrap: true,
                    padding: const EdgeInsets.only(bottom: 12),
                    children: [
                      if (eligible.isEmpty)
                        const EmptyLine('Nobody can take this order right now.')
                      else
                        for (final r in eligible) _row(context, r),
                      if (others.isNotEmpty) ...[
                        Padding(
                          padding: const EdgeInsets.fromLTRB(20, 16, 20, 4),
                          child: Text('NOT AVAILABLE',
                              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.6, color: c.muted)),
                        ),
                        for (final r in others) _row(context, r),
                      ],
                    ],
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(BuildContext context, RiderCandidate r) {
    final c = context.colors;
    final facts = [
      if (r.distanceKm != null) '${distance(r.distanceKm!)} away',
      if (r.activeDeliveries >= 2) 'busy (${r.activeDeliveries})' else if (r.activeDeliveries == 1) '1 active',
      fixAgeText(r.lastFixAgeSeconds),
    ].join(' · ');
    final fg = r.eligible ? c.ink : c.muted;
    return Opacity(
      opacity: r.eligible ? 1 : 0.6,
      child: ListTile(
        key: Key('rider-${r.id}'),
        enabled: r.eligible,
        onTap: r.eligible ? () => Navigator.pop(context, r) : null,
        leading: CircleAvatar(
          backgroundColor: r.eligible ? c.greenSoft : c.surface2,
          child: Icon(Icons.two_wheeler, color: r.eligible ? c.green : c.muted),
        ),
        title: Row(
          children: [
            Flexible(child: Text(r.name, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w700, color: fg))),
            if (r.code != null) ...[
              const SizedBox(width: 6),
              Text(r.code!, style: dataStyle(context, size: 12, weight: FontWeight.w600).copyWith(color: c.muted)),
            ],
          ],
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (!r.eligible)
              Text(ineligibleText(r.ineligibleReason),
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: c.deal)),
            Text(facts, style: TextStyle(fontSize: 12.5, color: c.muted)),
          ],
        ),
        trailing: r.eligible ? Icon(Icons.chevron_right, color: c.muted) : null,
      ),
    );
  }
}
