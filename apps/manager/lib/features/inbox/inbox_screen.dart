import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/push.dart';
import '../../core/format.dart';
import '../../models/inbox.dart';
import '../../state/inbox.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';

/// Every alert and ticket notice this manager was sent (§14, §15.7): unread
/// in bold, newest first. Tapping one marks it read and opens what it is
/// about. The Alerts shortcut on top shows what is still open.
class InboxScreen extends ConsumerWidget {
  const InboxScreen({super.key});

  void _open(BuildContext context, WidgetRef ref, InboxItem i) {
    if (i.isUnread) ref.read(inboxProvider.notifier).markRead(ids: [i.id]);
    // The server writes app paths now; rows written earlier carry the website's
    // (`/manager/support/<id>`, `/admin/orders/<id>`), which inAppPathFrom maps.
    final path = inboxPath(url: i.url, alertId: i.alertId, data: i.data);
    if (path != null) GoRouter.maybeOf(context)?.push(path);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final value = ref.watch(inboxProvider);
    final count = ref.watch(unreadCountProvider).value;
    final hasUnread = value.value?.items.any((i) => i.isUnread) ?? false;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Notifications'),
        backgroundColor: c.bg,
        actions: [
          TextButton(
            key: const Key('inbox-mark-all'),
            onPressed: hasUnread ? () => ref.read(inboxProvider.notifier).markRead(all: true) : null,
            child: const Text('Mark all read'),
          ),
        ],
      ),
      body: AsyncView(
        value: value,
        onRetry: () => ref.invalidate(inboxProvider),
        builder: (data) => RefreshIndicator(
          onRefresh: () async {
            await ref.read(inboxProvider.notifier).refresh();
            await ref.read(unreadCountProvider.notifier).refresh();
          },
          child: ListView(
            key: const Key('inbox-list'),
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
            children: [
              Material(
                color: c.surface,
                borderRadius: BorderRadius.circular(radiusBlock),
                child: ListTile(
                  key: const Key('inbox-alerts'),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(radiusBlock),
                    side: BorderSide(color: c.line),
                  ),
                  leading: Icon(Icons.notifications_active_outlined,
                      color: (count?.criticalAlerts ?? 0) > 0 ? c.deal : c.accentInk),
                  title: Text('Alerts', style: TextStyle(fontWeight: FontWeight.w700, color: c.ink)),
                  subtitle: Text(
                    count == null
                        ? 'What needs attention'
                        : [
                            '${count.openAlerts} open',
                            if (count.criticalAlerts > 0) '${count.criticalAlerts} critical',
                          ].join(' · '),
                    style: TextStyle(color: (count?.criticalAlerts ?? 0) > 0 ? c.deal : c.muted, fontSize: 12.5),
                  ),
                  trailing: Icon(Icons.chevron_right, color: c.muted),
                  onTap: () => GoRouter.maybeOf(context)?.push('/alerts'),
                ),
              ),
              const SizedBox(height: 12),
              if (data.items.isEmpty) const EmptyLine('No notifications yet.'),
              for (final i in data.items) ...[
                _Row(item: i, onTap: () => _open(context, ref, i)),
                Divider(height: 1, color: c.line),
              ],
              if (data.hasMore)
                Center(
                  child: TextButton(
                    onPressed: () => ref.read(inboxProvider.notifier).loadMore(),
                    child: Text(data.loadMoreFailed ? "Couldn't load more — tap to retry" : 'Load more'),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.item, required this.onTap});
  final InboxItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final unread = item.isUnread;
    return InkWell(
      key: Key('inbox-${item.id}'),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 6, right: 10),
              child: Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: unread ? c.accent : Colors.transparent, shape: BoxShape.circle),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(item.title,
                      style: TextStyle(color: c.ink, fontWeight: unread ? FontWeight.w800 : FontWeight.w500)),
                  if (item.body.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(item.body, style: TextStyle(color: c.muted, fontSize: 13)),
                    ),
                  if (item.createdAt != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(placedAt(item.createdAt), style: TextStyle(color: c.muted, fontSize: 12)),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
