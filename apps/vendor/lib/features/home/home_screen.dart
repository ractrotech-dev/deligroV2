import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/i18n.dart';
import '../../widgets/section_placeholder.dart';
import '../shell/shop_switcher.dart';

/// The dashboard (Phase 3). The app bar carries the shop switcher.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) => Scaffold(
        appBar: AppBar(title: const ShopSwitcher(), centerTitle: false),
        body: SectionPlaceholder(
          title: tr(ref, 'Dashboard', 'डैशबोर्ड'),
          icon: Icons.space_dashboard_outlined,
          showAppBar: false,
        ),
      );
}
