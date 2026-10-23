import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/entity_routes.dart';
import '../../models/alerts.dart';
import '../../models/outcome.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../orders/reason_dialog.dart';

Color alertSeverityColor(AppColors c, AlertSeverity s) => switch (s) {
      AlertSeverity.critical => c.deal,
      AlertSeverity.warning => c.amberText,
      AlertSeverity.info => c.blue,
    };

IconData alertKindIcon(AlertKind k) => switch (k) {
      AlertKind.orderNeedsIntervention || AlertKind.orderUnassigned => Icons.receipt_long_outlined,
      AlertKind.deliveryDelayed || AlertKind.deliveryFailed => Icons.local_shipping_outlined,
      AlertKind.highCancellationRate => Icons.cancel_outlined,
      AlertKind.vendorDowntime => Icons.storefront_outlined,
      AlertKind.riderShortage || AlertKind.riderInactive => Icons.two_wheeler_outlined,
      AlertKind.settlementDelayed || AlertKind.riderPayoutIssue || AlertKind.cashDiscrepancy =>
        Icons.account_balance_wallet_outlined,
      AlertKind.marketingRequestNew => Icons.campaign_outlined,
      AlertKind.complaintHighPriority => Icons.support_agent_outlined,
      AlertKind.incident => Icons.report_outlined,
      AlertKind.fraudSuspected => Icons.gpp_maybe_outlined,
      AlertKind.slaBreach => Icons.timer_outlined,
      AlertKind.unknown => Icons.notifications_outlined,
    };

/// "seen 3 min ago", "seen 2 h ago".
String seenAgo(DateTime? at, [DateTime? now]) {
  if (at == null) return '';
  final m = (now ?? DateTime.now()).difference(at).inMinutes;
  if (m < 1) return 'seen just now';
  if (m < 60) return 'seen $m min ago';
  if (m < 60 * 24) return 'seen ${m ~/ 60} h ago';
  return 'seen ${m ~/ (60 * 24)} d ago';
}

String alertRefusalText(Refused<Object?> r) => switch (r.code) {
      'already_resolved' => 'Someone already resolved this alert.',
      'bad_request' => 'Check the note and try again.',
      'permission_denied' || 'forbidden' => "You don't have permission for that. Ask an admin.",
      'not_found' => "This alert isn't in your zones.",
      'rate_limited' => 'Too many changes at once. Wait a moment.',
      _ => "That didn't go through (${r.code}).",
    };

/// Why raising an incident was refused. Each one pushes the whole zone and every
/// admin whatever they have muted, so a person gets 3 an hour.
String incidentRefusalText(Refused<Object?> r) => r.code == 'rate_limited'
    ? 'You have raised the most incidents allowed in an hour (3). If it is urgent, call an admin.'
    : alertRefusalText(r);

/// The screen an alert is about.
String alertTarget(Alert a) => routeForEntity(a.entityType, a.entityId, alertId: a.id);

/// Acknowledge or resolve one alert through [send]; resolving asks for a
/// note first. A network fault offers Retry with the same action.
Future<void> runAlertAction(
  BuildContext context,
  WidgetRef ref,
  Alert alert,
  String action,
  Future<Outcome<Alert>> Function(AlertAction a) send,
) async {
  final AlertAction a;
  if (action == 'resolve') {
    final note = await showReasonDialog(
      context,
      title: 'Resolve this alert',
      hint: 'What was done',
      submitLabel: 'Resolve',
      quickPicks: const ['Rider assigned', 'Customer called', 'Vendor contacted', 'Refund issued', 'False alarm'],
    );
    if (note == null || !context.mounted) return;
    a = AlertAction.resolve(note);
  } else {
    a = AlertAction.acknowledge();
  }
  await _send(context, ref, a, send);
}

Future<void> _send(
  BuildContext context,
  WidgetRef ref,
  AlertAction a,
  Future<Outcome<Alert>> Function(AlertAction a) send,
) async {
  final Outcome<Alert> out;
  try {
    out = await send(a);
  } on ApiException catch (e) {
    if (e.unauthorized) {
      await handleUnauthorized(ref, e);
      return;
    }
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(
        content: Text("That didn't go through. ${e.friendly}"),
        duration: const Duration(seconds: 8),
        action: SnackBarAction(label: 'Retry', onPressed: () => _send(context, ref, a, send)),
      ));
    return;
  }
  if (!context.mounted) return;
  showSnack(context, switch (out) {
    Applied() => a.action == 'resolve' ? 'Alert resolved.' : 'Alert acknowledged.',
    Refused() => alertRefusalText(out),
  });
}

/// One alert: severity mark, title, what happened, where and when, and the
/// three things a manager does with it.
class AlertCard extends ConsumerWidget {
  const AlertCard({super.key, required this.alert, required this.zoneName, required this.onAct});
  final Alert alert;
  final String? zoneName;
  final void Function(String action) onAct;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final a = alert;
    final color = alertSeverityColor(c, a.severity);
    final meta = [
      a.kind.label,
      ?zoneName,
      seenAgo(a.lastSeenAt ?? a.openedAt),
      if (a.reopenCount > 0) 'Reopened ${a.reopenCount} ${a.reopenCount == 1 ? 'time' : 'times'}',
    ].where((s) => s.isNotEmpty).join(' · ');
    return Material(
      color: c.surface,
      borderRadius: BorderRadius.circular(radiusBlock),
      child: InkWell(
        key: Key('alert-${a.id}'),
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: () => GoRouter.maybeOf(context)?.push('/alerts/${a.id}'),
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 6),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(radiusBlock),
            border: Border.all(color: a.severity == AlertSeverity.critical ? color.withValues(alpha: 0.5) : c.line),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 34,
                    height: 34,
                    decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
                    child: Icon(alertKindIcon(a.kind), color: color, size: 19),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(children: [
                          Text(a.severity.label,
                              style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w800)),
                          if (a.status == AlertStatus.acknowledged && a.acknowledgedBy != null) ...[
                            const SizedBox(width: 6),
                            Flexible(
                              child: Text('· acknowledged by ${a.acknowledgedBy!.name}',
                                  overflow: TextOverflow.ellipsis, style: TextStyle(color: c.muted, fontSize: 12)),
                            ),
                          ],
                        ]),
                        const SizedBox(height: 2),
                        Text(a.title, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink, fontSize: 15)),
                        if (a.body.isNotEmpty) ...[
                          const SizedBox(height: 2),
                          Text(a.body, style: TextStyle(color: c.ink, fontSize: 13.5)),
                        ],
                        const SizedBox(height: 4),
                        Text(meta, style: TextStyle(color: c.muted, fontSize: 12)),
                        if (a.isResolved && a.resolution != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 4),
                            child: Text(
                              a.cleared
                                  ? 'Cleared on its own'
                                  : 'Resolved${a.resolvedBy == null ? '' : ' by ${a.resolvedBy!.name}'}: ${a.resolution}',
                              style: TextStyle(color: c.green, fontSize: 12.5),
                            ),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
              OverflowBar(
                alignment: MainAxisAlignment.end,
                overflowAlignment: OverflowBarAlignment.end,
                children: [
                  if (a.status == AlertStatus.open)
                    TextButton(key: Key('alert-ack-${a.id}'), onPressed: () => onAct('acknowledge'), child: const Text('Acknowledge')),
                  if (!a.isResolved)
                    TextButton(key: Key('alert-resolve-${a.id}'), onPressed: () => onAct('resolve'), child: const Text('Resolve')),
                  TextButton(
                    key: Key('alert-open-${a.id}'),
                    onPressed: () => GoRouter.maybeOf(context)?.push(alertTarget(a)),
                    child: const Text('Open'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
