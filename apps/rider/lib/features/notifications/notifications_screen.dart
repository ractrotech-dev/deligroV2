import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/push_routes.dart';
import '../../models/inbox.dart';
import '../../state/clock.dart';
import '../../state/support.dart';
import '../../state/providers.dart' show riderKeyProvider;
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';

/// The inbox sits above the tabs, so the bell works from anywhere.
final notificationsRoute = GoRoute(
  path: notificationsPath,
  builder: (_, _) => const NotificationsScreen(),
);

/// The bell: opens the inbox, with the unread count on it.
class NotificationBell extends ConsumerWidget {
  const NotificationBell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final unread = ref.watch(unreadCountProvider);
    return IconButton(
      key: const Key('notification-bell'),
      tooltip: unread > 0 ? 'Notifications, $unread unread' : 'Notifications',
      onPressed: () => context.push(notificationsPath),
      icon: Badge(
        isLabelVisible: unread > 0,
        label: Text(unread > 99 ? '99+' : '$unread', key: const Key('bell-count')),
        child: const Icon(Icons.notifications_none_rounded, size: 26),
      ),
    );
  }
}

IconData _iconFor(String category) => switch (category) {
      'offers' => Icons.two_wheeler_rounded,
      'cancellations' => Icons.event_busy_rounded,
      'pickup_reminders' => Icons.storefront_rounded,
      'delivery_updates' => Icons.edit_note_rounded,
      'payouts' => Icons.account_balance_wallet_outlined,
      'incentives' => Icons.emoji_events_outlined,
      'announcements' => Icons.campaign_outlined,
      'support' => Icons.support_agent_rounded,
      'cash' => Icons.payments_outlined,
      'documents' => Icons.description_outlined,
      'high_demand' => Icons.local_fire_department_outlined,
      'safety' => Icons.health_and_safety_outlined,
      _ => Icons.notifications_none_rounded,
    };

/// "Today", "Yesterday", or "21 Oct 2026".
String dayHeading(DateTime at, DateTime now) {
  final day = DateTime(at.year, at.month, at.day);
  final today = DateTime(now.year, now.month, now.day);
  final diff = today.difference(day).inDays;
  if (diff == 0) return 'Today';
  if (diff == 1) return 'Yesterday';
  return DateFormat('d MMM y').format(day);
}

String _time(DateTime at) => DateFormat('h:mm a').format(at);

/// The live announcements to pin on top. One that also reached the inbox as a
/// row (its `data.announcementId`) shows once, as that row.
List<Announcement> pinnedAnnouncements(List<Announcement> live, List<InboxItem> items) {
  final inInbox = {
    for (final i in items)
      if (i.data['announcementId'] != null) '${i.data['announcementId']}',
  };
  return [for (final a in live) if (!inInbox.contains(a.id)) a];
}

/// Everything Deligro sent the rider, newest first and grouped by day, with
/// the live announcements pinned on top.
class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  void _open(BuildContext context, WidgetRef ref, InboxItem item) {
    ref.read(inboxProvider(ref.read(riderKeyProvider)).notifier).markRead(item.id);
    final router = GoRouter.of(context);
    final path = routeForNotification(
      category: item.category,
      url: item.data['url'] is String ? item.data['url'] as String : null,
      data: item.data,
      exists: (p) => !router.configuration.findMatch(Uri.parse(p)).isError,
    );
    // The inbox is where the rider already is.
    if (path == notificationsPath) return;
    router.go(path);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final inbox = ref.watch(inboxProvider(ref.watch(riderKeyProvider)));
    final announcements = ref.watch(announcementsProvider(ref.watch(riderKeyProvider))).value ?? const <Announcement>[];
    final now = ref.watch(clockProvider)().toLocal();
    final live = [
      for (final a in announcements)
        if (a.endsAt == null || a.endsAt!.isAfter(now)) a,
    ];
    final unread = inbox.value?.unread ?? 0;
    final c = context.colors;

    Future<void> refresh() async {
      ref.invalidate(inboxProvider);
      ref.invalidate(announcementsProvider);
      await ref.read(inboxProvider(ref.read(riderKeyProvider)).future).then<void>((_) {}, onError: (_) {});
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          TextButton(
            key: const Key('mark-all-read'),
            onPressed: unread > 0
                ? () async {
                    final ok = await ref.read(inboxProvider(ref.read(riderKeyProvider)).notifier).markAllRead();
                    if (!ok && context.mounted) showSnack(context, "Couldn't update. Try again.");
                  }
                : null,
            child: const Text('Mark all read'),
          ),
        ],
      ),
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: refresh,
          child: AsyncBody<InboxState>(
            value: inbox,
            onRetry: () => ref.invalidate(inboxProvider),
            builder: (s) {
              if (s.items.isEmpty && live.isEmpty) {
                return ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: const [
                    SizedBox(height: 80),
                    EmptyState(
                      icon: Icons.notifications_none_rounded,
                      title: 'Nothing here yet',
                      body: 'Offers, reminders, replies and news from Deligro show up here.',
                    ),
                  ],
                );
              }
              final rows = <Widget>[];
              for (final a in pinnedAnnouncements(live, s.items)) {
                rows.add(_AnnouncementCard(announcement: a));
                rows.add(const SizedBox(height: 10));
              }
              String? last;
              for (final item in s.items) {
                final at = item.createdAt;
                final heading = at == null ? 'Earlier' : dayHeading(at, now);
                if (heading != last) {
                  last = heading;
                  rows.add(Padding(
                    padding: EdgeInsets.fromLTRB(4, rows.isEmpty ? 4 : 14, 4, 8),
                    child: Text(heading.toUpperCase(), style: Theme.of(context).textTheme.labelSmall),
                  ));
                }
                rows.add(_Row(item: item, onTap: () => _open(context, ref, item)));
                rows.add(const SizedBox(height: 8));
              }
              if (s.hasMore) {
                rows.add(Center(
                  child: TextButton(
                    key: const Key('load-older'),
                    onPressed: s.loadingMore ? null : () => ref.read(inboxProvider(ref.read(riderKeyProvider)).notifier).loadMore(),
                    child: s.loadingMore
                        ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                        : Text('Older notifications', style: TextStyle(color: c.accentInk)),
                  ),
                ));
              }
              return ListView(
                key: const Key('inbox-list'),
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 28),
                children: rows,
              );
            },
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
    final at = item.createdAt;
    return Material(
      color: item.read ? c.surface : c.accentSoft,
      borderRadius: BorderRadius.circular(radiusBlock),
      child: InkWell(
        key: Key('inbox-${item.id}'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(radiusBlock),
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 12, 14, 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(radiusBlock),
            border: Border.all(color: item.read ? c.line : Colors.transparent),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(_iconFor(item.category), size: 24, color: item.read ? c.muted : c.accentInk),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      item.title,
                      style: TextStyle(
                        fontWeight: item.read ? FontWeight.w600 : FontWeight.w800,
                        fontSize: 15.5,
                      ),
                    ),
                    if (item.body.isNotEmpty) ...[
                      const SizedBox(height: 3),
                      Text(item.body, style: TextStyle(color: c.muted, height: 1.35, fontSize: 14)),
                    ],
                    if (at != null) ...[
                      const SizedBox(height: 4),
                      Text(_time(at), style: TextStyle(color: c.muted, fontSize: 12)),
                    ],
                  ],
                ),
              ),
              if (!item.read)
                Padding(
                  padding: const EdgeInsets.only(left: 8, top: 4),
                  child: Container(
                    key: Key('unread-${item.id}'),
                    width: 10,
                    height: 10,
                    decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AnnouncementCard extends StatelessWidget {
  const _AnnouncementCard({required this.announcement});

  final Announcement announcement;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      key: Key('announcement-${announcement.id}'),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.pop,
        borderRadius: BorderRadius.circular(radiusBlock),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.campaign_outlined, color: c.popInk),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  announcement.title,
                  style: TextStyle(color: c.popInk, fontWeight: FontWeight.w800, fontSize: 15.5),
                ),
                const SizedBox(height: 3),
                Text(announcement.body, style: TextStyle(color: c.popInk, height: 1.35)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
