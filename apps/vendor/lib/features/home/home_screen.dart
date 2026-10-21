import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/dashboard.dart';
import '../../state/dashboard.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/stage.dart';
import '../shell/shop_switcher.dart';

/// The dashboard (requirements §1), laid out as the client's mockup: the shop,
/// then every figure in a two-column grid, then marketing requests.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dash = ref.watch(dashboardProvider);
    return Scaffold(
      appBar: AppBar(
        title: const ShopSwitcher(),
        centerTitle: false,
        actions: [
          IconButton(
            tooltip: 'Notifications',
            onPressed: () => context.push('/more/notifications'),
            icon: const Icon(Icons.notifications_none_rounded),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.read(dashboardProvider.notifier).refresh(),
        child: dash.when(
          loading: () => ListView(
            children: const [SizedBox(height: 240, child: Center(child: CircularProgressIndicator()))],
          ),
          error: (e, _) => ListView(
            padding: const EdgeInsets.all(32),
            children: [
              const SizedBox(height: 80),
              Text(e is ApiException ? e.friendly() : 'The dashboard couldn\'t load.', textAlign: TextAlign.center),
              const SizedBox(height: 12),
              Center(
                child: FilledButton(onPressed: () => ref.invalidate(dashboardProvider), child: Text('Retry')),
              ),
            ],
          ),
          data: (d) => _Body(d: d),
        ),
      ),
    );
  }
}

class _Body extends ConsumerWidget {
  const _Body({required this.d});
  final Dashboard d;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(vendorMeProvider).value;
    final money = d.money;
    final c = context.colors;

    final tiles = <Widget>[
      _Tile(
        icon: Icons.today_rounded,
        tint: c.accent,
        label: 'Today\'s sale',
        value: rupees(d.todaySale),
        change: d.todayChange,
        changeNote: 'vs yesterday',
        onTap: () => context.go('/reports'),
      ),
      _Tile(
        icon: Icons.storefront_rounded,
        tint: c.accent,
        label: 'Total sale',
        value: rupees(d.totalSale),
        change: d.monthChange,
        changeNote: 'this month vs last',
        onTap: () => context.go('/reports'),
      ),
      _Tile(
        icon: Icons.notifications_active_rounded,
        tint: c.accentInk,
        label: 'New orders',
        value: '${d.liveNew}',
        highlight: d.liveNew > 0,
        onTap: () => context.go('/orders?filter=new'),
      ),
      _Tile(
        icon: Icons.thumb_up_alt_rounded,
        tint: c.blue,
        label: 'Accepted',
        value: '${d.liveAccepted}',
        onTap: () => context.go('/orders?filter=accepted'),
      ),
      _Tile(
        icon: Icons.soup_kitchen_rounded,
        tint: popText(context),
        label: 'Preparing',
        value: '${d.livePreparing}',
        onTap: () => context.go('/orders?filter=preparing'),
      ),
      _Tile(
        icon: Icons.shopping_bag_rounded,
        tint: c.green,
        label: 'Ready for pickup',
        value: '${d.liveReady}',
        onTap: () => context.go('/orders?filter=ready'),
      ),
      _Tile(
        icon: Icons.check_circle_rounded,
        tint: c.green,
        label: 'Completed today',
        value: '${d.todayCompleted}',
        onTap: () => context.go('/orders?tab=past'),
      ),
      _Tile(
        icon: Icons.cancel_rounded,
        tint: c.deal,
        label: 'Cancelled today',
        value: '${d.todayCancelled}',
        onTap: () => context.go('/orders?tab=past&kind=cancelled'),
      ),
      if (money != null) ...[
        _Tile(
          icon: Icons.verified_rounded,
          tint: c.green,
          label: 'Paid orders',
          value: '${money.paidOrders}',
          note: money.partlyPaidOrders > 0 ? '${money.partlyPaidOrders} partly paid' : null,
          onTap: () => context.go('/payments'),
        ),
        _Tile(
          icon: Icons.schedule_rounded,
          tint: popText(context),
          label: 'Unpaid orders',
          value: '${money.unpaidOrders}',
          onTap: () => context.go('/payments'),
        ),
      ],
    ];

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
      children: [
        if (me != null) _ShopCard(name: me.activeShop.name, open: me.activeShop.isOpen, ordersToday: d.todayOrders),
        const SizedBox(height: 12),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          childAspectRatio: MediaQuery.textScalerOf(context).scale(1) > 1.15 ? 1.15 : 1.45,
          children: tiles,
        ),
        if (money != null) ...[
          const SizedBox(height: 10),
          _WideTile(
            icon: Icons.account_balance_wallet_rounded,
            tint: money.paymentDue < 0 ? c.deal : c.green,
            label: money.paymentDue < 0 ? 'You owe Deligro' : 'Payment due to you',
            value: rupees(money.paymentDue.abs()),
            note: money.paymentDue < 0
                ? 'Commission on cash orders you collected, not yet settled'
                : 'Earnings on delivered orders not yet paid to you',
            onTap: () => context.go('/payments'),
          ),
          const SizedBox(height: 10),
          _WideTile(
            icon: Icons.savings_rounded,
            tint: c.green,
            label: 'Total vendor earnings',
            value: rupees(money.totalEarnings),
            note: 'After Deligro commission and refunds, all delivered orders',
            onTap: () => context.go('/payments'),
          ),
        ] else ...[
          const SizedBox(height: 10),
          Text(
            'Earnings and payments are switched off for your shop by Deligro.',
            style: TextStyle(color: c.muted, fontSize: 13),
          ),
        ],
        const SizedBox(height: 10),
        _MarketingRow(m: d.marketing),
      ],
    );
  }
}

class _ShopCard extends ConsumerWidget {
  const _ShopCard({required this.name, required this.open, required this.ordersToday});
  final String name;
  final bool open;
  final int ordersToday;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Material(
      color: c.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radiusBlock),
        side: BorderSide(color: c.line),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: () => context.push('/more/store'),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: Image.asset('assets/brand/mark.png', width: 46, height: 46),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 2),
                    Text('$ordersToday orders today', style: TextStyle(color: c.muted, fontSize: 13)),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: open ? c.greenSoft : c.surface2,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(color: open ? c.green : c.muted, shape: BoxShape.circle),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      open ? 'Open' : 'Closed',
                      style: TextStyle(color: open ? c.green : c.muted, fontWeight: FontWeight.w700, fontSize: 12.5),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({
    required this.icon,
    required this.tint,
    required this.label,
    required this.value,
    required this.onTap,
    this.change,
    this.changeNote,
    this.note,
    this.highlight = false,
  });

  final IconData icon;
  final Color tint;
  final String label;
  final String value;
  final VoidCallback onTap;
  final double? change;
  final String? changeNote;
  final String? note;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final up = (change ?? 0) >= 0;
    return Material(
      color: highlight ? c.accentSoft : c.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radiusBlock),
        side: BorderSide(color: highlight ? c.accent.withValues(alpha: .5) : c.line),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 28,
                    height: 28,
                    decoration: BoxDecoration(
                      color: tint.withValues(alpha: .13),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Icon(icon, size: 17, color: tint),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      label,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w600, height: 1.2),
                    ),
                  ),
                ],
              ),
              const Spacer(),
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Text(value, style: dataStyle(context, size: 21, weight: FontWeight.w800)),
              ),
              if (change != null)
                Text(
                  '${up ? '↑' : '↓'} ${change!.abs().toStringAsFixed(change!.abs() < 10 ? 1 : 0)}%  ${changeNote ?? ''}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: up ? c.green : c.deal, fontSize: 11.5, fontWeight: FontWeight.w700),
                )
              else if (note != null)
                Text(
                  note!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: c.muted, fontSize: 11.5),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _WideTile extends StatelessWidget {
  const _WideTile({
    required this.icon,
    required this.tint,
    required this.label,
    required this.value,
    required this.note,
    required this.onTap,
  });
  final IconData icon;
  final Color tint;
  final String label;
  final String value;
  final String note;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Material(
      color: c.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radiusBlock),
        side: BorderSide(color: c.line),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(radiusBlock),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: tint.withValues(alpha: .14), borderRadius: BorderRadius.circular(12)),
                child: Icon(icon, color: tint),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w600),
                    ),
                    Text(value, style: dataStyle(context, size: 22, weight: FontWeight.w800)),
                    Text(note, style: TextStyle(color: c.muted, fontSize: 11.5)),
                  ],
                ),
              ),
              Icon(Icons.chevron_right_rounded, color: c.muted),
            ],
          ),
        ),
      ),
    );
  }
}

class _MarketingRow extends ConsumerWidget {
  const _MarketingRow({required this.m});
  final MarketingCounts m;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final parts = <String>[
      if (m.pending > 0) '${m.pending} pending',
      if (m.approved > 0) '${m.approved} approved',
      if (m.inProgress > 0) '${m.inProgress} running',
      if (m.completed > 0) '${m.completed} completed',
      if (m.rejected > 0) '${m.rejected} rejected',
    ];
    final summary = parts.isEmpty ? 'Ask Deligro to feature your shop or run a campaign' : parts.join(' · ');
    return Material(
      color: c.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radiusBlock),
        side: BorderSide(color: c.line),
      ),
      child: ListTile(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusBlock)),
        leading: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(12)),
          child: Icon(Icons.campaign_rounded, color: c.deal),
        ),
        title: Text('Marketing requests', style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(summary, maxLines: 2, overflow: TextOverflow.ellipsis),
        trailing: Icon(Icons.chevron_right_rounded, color: c.muted),
        onTap: () => context.push('/more/marketing'),
      ),
    );
  }
}
