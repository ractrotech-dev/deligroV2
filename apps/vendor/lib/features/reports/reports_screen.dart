import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../widgets/section_placeholder.dart';
import 'analytics_view.dart';

/// Reports: sales statistics (§2) and the sales report with downloads (§5).
class ReportsScreen extends ConsumerWidget {
  const ReportsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => DefaultTabController(
    length: 2,
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
      body: TabBarView(
        children: [
          const AnalyticsView(),
          SectionPlaceholder(title: 'Sales report', icon: Icons.summarize_outlined, showAppBar: false),
        ],
      ),
    ),
  );
}
