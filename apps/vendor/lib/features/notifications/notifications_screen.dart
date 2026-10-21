import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/growth.dart';
import '../../state/growth.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

/// Notifications (requirements §13): everything Deligro has told the shop —
/// orders, pending orders, low stock, payments, marketing, support, reviews —
/// with live announcements pinned on top. Tap one to go where it's about.
class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  static IconData iconFor(String category) => switch (category) {
    'orders' => Icons.receipt_long_rounded,
    'pending_orders' => Icons.alarm_rounded,
    'low_stock' => Icons.inventory_2_rounded,
    'payments' => Icons.account_balance_wallet_rounded,
    'marketing' => Icons.campaign_rounded,
    'support' => Icons.support_agent_rounded,
    'reviews' => Icons.star_rounded,
    'announcements' => Icons.campaign_outlined,
    _ => Icons.notifications_rounded,
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(inboxProvider);
    final unread = async.value?.unread ?? 0;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          if (unread > 0)
            TextButton(
              onPressed: () => runWrite(context, ref, () => ref.read(inboxProvider.notifier).markAllRead()),
              child: const Text('Mark all read'),
            ),
        ],
      ),
      body: switch (async) {
        AsyncData(:final value) => RefreshIndicator(
          onRefresh: () => ref.read(inboxProvider.notifier).refresh(),
          child: _list(context, ref, value),
        ),
        AsyncError(:final error) => LoadFailed(error: error, onRetry: () => ref.invalidate(inboxProvider)),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }

  Widget _list(BuildContext context, WidgetRef ref, Inbox inbox) {
    final c = context.colors;
    if (!inbox.available) {
      return ListView(
        children: [
          Padding(
            padding: const EdgeInsets.all(40),
            child: Text(
              'Notifications will appear here after Deligro\'s next update.',
              textAlign: TextAlign.center,
              style: TextStyle(color: c.muted),
            ),
          ),
        ],
      );
    }
    // Grouped by day, newest first.
    final day = DateFormat('EEEE, d MMM', 'en_IN');
    final groups = <String, List<InboxItem>>{};
    for (final i in inbox.items) {
      final d = i.createdAt;
      final now = DateTime.now();
      final key = d == null
          ? 'Earlier'
          : DateUtils.isSameDay(d, now)
          ? 'Today'
          : DateUtils.isSameDay(d, now.subtract(const Duration(days: 1)))
          ? 'Yesterday'
          : day.format(d);
      groups.putIfAbsent(key, () => []).add(i);
    }
    return ListView(
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        for (final a in inbox.announcements)
          Padding(
            padding: const EdgeInsets.fromLTRB(0, 8, 0, 0),
            child: Panel(
              tint: c.accentSoft,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.campaign_rounded, color: c.accentInk),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(a.title, style: const TextStyle(fontWeight: FontWeight.w800)),
                        const SizedBox(height: 2),
                        Text(a.body),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        if (inbox.items.isEmpty)
          Padding(
            padding: const EdgeInsets.all(40),
            child: Column(
              children: [
                Icon(Icons.notifications_none_rounded, size: 44, color: c.muted),
                const SizedBox(height: 12),
                Text(
                  'Nothing yet. New orders, payouts and replies show up here.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: c.muted),
                ),
              ],
            ),
          ),
        for (final g in groups.entries) ...[
          SectionHeading(g.key),
          for (final i in g.value)
            ListTile(
              contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 2),
              leading: CircleAvatar(
                backgroundColor: i.read ? c.surface2 : c.accentSoft,
                child: Icon(iconFor(i.category), color: i.read ? c.muted : c.accentInk, size: 20),
              ),
              title: Text(i.title, style: TextStyle(fontWeight: i.read ? FontWeight.w500 : FontWeight.w800)),
              subtitle: Text('${i.body}\n${placedAt(i.createdAt)}', style: TextStyle(color: c.muted, fontSize: 12.5)),
              isThreeLine: true,
              trailing: i.read
                  ? null
                  : Container(
                      width: 9,
                      height: 9,
                      decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle),
                    ),
              onTap: () {
                ref.read(inboxProvider.notifier).markRead(i.id);
                final url = i.url;
                if (url != null && url.startsWith('/')) context.push(url);
              },
            ),
        ],
        if (inbox.hasMore)
          Padding(
            padding: const EdgeInsets.all(16),
            child: OutlinedButton(
              onPressed: () => runWrite(context, ref, () => ref.read(inboxProvider.notifier).loadMore()),
              child: const Text('Show older'),
            ),
          ),
      ],
    );
  }
}
