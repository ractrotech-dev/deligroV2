import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../models/support.dart';
import '../../widgets/rows.dart';
import 'incident_report_screen.dart';
import 'sos_sheet.dart';

const safetyPath = '/safety';
const _reportPath = '$safetyPath/report';

/// Safety sits above the tabs, so Home and More both reach it and Back
/// returns to where the rider was.
final safetyRoute = GoRoute(
  path: safetyPath,
  builder: (_, _) => const SafetyScreen(),
  routes: [
    GoRoute(
      path: 'report',
      builder: (_, state) {
        final kind = state.extra is SosKind ? state.extra as SosKind : SosKind.unsafeSituation;
        return IncidentReportScreen(kind: kind);
      },
    ),
  ],
);

IconData _icon(SosKind k) => switch (k) {
      SosKind.unsafeSituation => Icons.report_gmailerrorred_rounded,
      SosKind.accident => Icons.car_crash_outlined,
      SosKind.vehicleBreakdown => Icons.build_circle_outlined,
      SosKind.harassmentThreat => Icons.front_hand_outlined,
      SosKind.suspiciousOrderLocation => Icons.visibility_outlined,
      SosKind.alert => Icons.sos_rounded,
    };

/// Help in an emergency, and the forms for reporting what happened.
class SafetyScreen extends StatelessWidget {
  const SafetyScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Safety')),
      body: SafeArea(
        bottom: false,
        child: SingleChildScrollView(
          key: const Key('safety-screen'),
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SosActions(),
              const RowsLabel('Report something'),
              RowsCard(
                children: [
                  for (final k in SosKind.reports)
                    NavRow(
                      key: Key('report-${k.wire}'),
                      icon: _icon(k),
                      title: k.label,
                      onTap: () => context.push(_reportPath, extra: k),
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

/// The Safety row for Home and More.
class SafetyRow extends StatelessWidget {
  const SafetyRow({super.key});

  @override
  Widget build(BuildContext context) => NavRow(
        key: const Key('row-safety'),
        icon: Icons.health_and_safety_outlined,
        title: 'Safety',
        subtitle: 'SOS, call 112, report an incident',
        onTap: () => context.push(safetyPath),
      );
}
