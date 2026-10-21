import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../shell/nav.dart';

/// Everything without a bottom tab, filtered to what this person may open.
class MoreScreen extends ConsumerWidget {
  const MoreScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(managerMeProvider).value;
    final c = context.colors;
    final items = me == null ? const <MoreItem>[] : moreItemsFor(me);
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text('More')),
      body: ListView.separated(
        padding: const EdgeInsets.symmetric(vertical: 8),
        itemCount: items.length,
        separatorBuilder: (_, _) => Divider(height: 1, indent: 72, color: c.line),
        itemBuilder: (context, i) {
          final m = items[i];
          return ListTile(
            key: Key('more-${m.path}'),
            minTileHeight: 64,
            leading: Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(12)),
              child: Icon(m.icon, color: c.accentInk, size: 22),
            ),
            title: Text(m.en, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
            subtitle: m.subtitleEn == null
                ? null
                : Text(m.subtitleEn!,
                    style: TextStyle(fontSize: 12.5, color: c.muted)),
            trailing: Icon(Icons.chevron_right, color: c.muted),
            onTap: () => context.push(m.path),
          );
        },
      ),
    );
  }
}
