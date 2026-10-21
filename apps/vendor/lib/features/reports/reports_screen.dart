import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n.dart';
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
            title: Text(tr(ref, 'Reports', 'रिपोर्ट')),
            bottom: TabBar(tabs: [
              Tab(text: tr(ref, 'Sales analytics', 'बिक्री के आँकड़े')),
              Tab(text: tr(ref, 'Sales report', 'बिक्री रिपोर्ट')),
            ]),
          ),
          body: TabBarView(children: [
            const AnalyticsView(),
            SectionPlaceholder(title: tr(ref, 'Sales report', 'बिक्री रिपोर्ट'), icon: Icons.summarize_outlined, showAppBar: false),
          ]),
        ),
      );
}
