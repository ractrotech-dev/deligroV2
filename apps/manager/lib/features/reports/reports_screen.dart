import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../state/reports.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';

/// Reports (§13): the kinds this manager may run, each with a line on what
/// it holds. Finance kinds appear only with Finance switched on.
class ReportsScreen extends ConsumerWidget {
  const ReportsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final value = ref.watch(reportKindsProvider);
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Reports'), backgroundColor: c.bg),
      body: AsyncView(
        value: value,
        onRetry: () => ref.invalidate(reportKindsProvider),
        builder: (list) => list.kinds.isEmpty
            ? const EmptyLine('No reports are switched on for your account.')
            : ListView(
                padding: const EdgeInsets.only(bottom: 32),
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                    child: Text('Pick a report, set the dates and filters, then export to CSV, Excel or PDF.',
                        style: TextStyle(color: c.muted)),
                  ),
                  for (final k in list.kinds)
                    ListTile(
                      key: Key('report-kind-${k.kind}'),
                      leading: Icon(Icons.summarize_outlined, color: c.muted),
                      title: Text(k.label),
                      subtitle: k.blurb.isEmpty ? null : Text(k.blurb),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => context.push('/more/reports/${k.kind}'),
                    ),
                ],
              ),
      ),
    );
  }
}
