import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/feature_gates.dart';
import '../../state/session.dart';
import 'analytics_view.dart';
import 'sales_report_view.dart';

/// Reports: sales statistics (§2) and the sales report with downloads (§5). The
/// statistics are money figures, so they follow the shop's Earnings switch; the
/// report stays and leaves its money columns out.
class ReportsScreen extends ConsumerWidget {
  const ReportsScreen({super.key, this.tab});

  /// `report` opens on the sales report (Invoices → Statement links here).
  final String? tab;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(vendorMeProvider).value;
    if (me != null && !me.can(earningsFeature)) {
      return Scaffold(
        appBar: AppBar(title: Text('Sales report')),
        body: const SalesReportView(),
      );
    }
    return DefaultTabController(
      key: ValueKey(tab),
      length: 2,
      initialIndex: tab == 'report' ? 1 : 0,
      child: Scaffold(
        appBar: AppBar(
          title: Text('Reports'),
          bottom: TabBar(
            tabs: [
              Tab(text: 'Sales analytics'),
              Tab(text: 'Sales report'),
            ],
          ),
        ),
        body: TabBarView(children: [const AnalyticsView(), const SalesReportView()]),
      ),
    );
  }
}
