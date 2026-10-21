import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/i18n.dart';
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
            tooltip: tr(ref, 'Notifications', 'सूचनाएँ'),
            onPressed: () => context.push('/more/notifications'),
            icon: const Icon(Icons.notifications_none_rounded),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => ref.read(dashboardProvider.notifier).refresh(),
        child: dash.when(
          loading: () => ListView(children: const [SizedBox(height: 240, child: Center(child: CircularProgressIndicator()))]),
          error: (e, _) => ListView(
            padding: const EdgeInsets.all(32),
            children: [
              const SizedBox(height: 80),
              Text(
                e is ApiException ? e.friendly(hi: isHindi(ref)) : tr(ref, 'The dashboard couldn\'t load.', 'डैशबोर्ड लोड नहीं हुआ।'),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              Center(
                child: FilledButton(
                  onPressed: () => ref.invalidate(dashboardProvider),
                  child: Text(tr(ref, 'Retry', 'फिर कोशिश करें')),
                ),
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
        label: tr(ref, 'Today\'s sale', 'आज की बिक्री'),
        value: rupees(d.todaySale),
        change: d.todayChange,
        changeNote: tr(ref, 'vs yesterday', 'कल से'),
        onTap: () => context.go('/reports'),
      ),
      _Tile(
        icon: Icons.storefront_rounded,
        tint: c.accent,
        label: tr(ref, 'Total sale', 'कुल बिक्री'),
        value: rupees(d.totalSale),
        change: d.monthChange,
        changeNote: tr(ref, 'this month vs last', 'इस महीने बनाम पिछला'),
        onTap: () => context.go('/reports'),
      ),
      _Tile(
        icon: Icons.notifications_active_rounded,
        tint: c.accentInk,
        label: tr(ref, 'New orders', 'नए ऑर्डर'),
        value: '${d.liveNew}',
        highlight: d.liveNew > 0,
        onTap: () => context.go('/orders?filter=new'),
      ),
      _Tile(
        icon: Icons.thumb_up_alt_rounded,
        tint: c.blue,
        label: tr(ref, 'Accepted', 'स्वीकार'),
        value: '${d.liveAccepted}',
        onTap: () => context.go('/orders?filter=accepted'),
      ),
      _Tile(
        icon: Icons.soup_kitchen_rounded,
        tint: popText(context),
        label: tr(ref, 'Preparing', 'बन रहे हैं'),
        value: '${d.livePreparing}',
        onTap: () => context.go('/orders?filter=preparing'),
      ),
      _Tile(
        icon: Icons.shopping_bag_rounded,
        tint: c.green,
        label: tr(ref, 'Ready for pickup', 'पिकअप के लिए तैयार'),
        value: '${d.liveReady}',
        onTap: () => context.go('/orders?filter=ready'),
      ),
      _Tile(
        icon: Icons.check_circle_rounded,
        tint: c.green,
        label: tr(ref, 'Completed today', 'आज पूरे'),
        value: '${d.todayCompleted}',
        onTap: () => context.go('/orders?tab=past'),
      ),
      _Tile(
        icon: Icons.cancel_rounded,
        tint: c.deal,
        label: tr(ref, 'Cancelled today', 'आज रद्द'),
        value: '${d.todayCancelled}',
        onTap: () => context.go('/orders?tab=past&kind=cancelled'),
      ),
      if (money != null) ...[
        _Tile(
          icon: Icons.verified_rounded,
          tint: c.green,
          label: tr(ref, 'Paid orders', 'भुगतान हुए ऑर्डर'),
          value: '${money.paidOrders}',
          note: money.partlyPaidOrders > 0
              ? tr(ref, '${money.partlyPaidOrders} partly paid', '${money.partlyPaidOrders} आंशिक भुगतान')
              : null,
          onTap: () => context.go('/payments'),
        ),
        _Tile(
          icon: Icons.schedule_rounded,
          tint: popText(context),
          label: tr(ref, 'Unpaid orders', 'बाकी भुगतान वाले ऑर्डर'),
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
            label: money.paymentDue < 0 ? tr(ref, 'You owe Deligro', 'Deligro को देना है') : tr(ref, 'Payment due to you', 'आपको मिलना है'),
            value: rupees(money.paymentDue.abs()),
            note: money.paymentDue < 0
                ? tr(ref, 'Commission on cash orders you collected, not yet settled', 'आपके लिए नकद ऑर्डर का कमीशन, अभी सेटल नहीं हुआ')
                : tr(ref, 'Earnings on delivered orders not yet paid to you', 'डिलीवर ऑर्डर की कमाई जो अभी आपको नहीं मिली'),
            onTap: () => context.go('/payments'),
          ),
          const SizedBox(height: 10),
          _WideTile(
            icon: Icons.savings_rounded,
            tint: c.green,
            label: tr(ref, 'Total vendor earnings', 'कुल वेंडर कमाई'),
            value: rupees(money.totalEarnings),
            note: tr(ref, 'After Deligro commission and refunds, all delivered orders', 'Deligro कमीशन और रिफंड के बाद, सभी डिलीवर ऑर्डर'),
            onTap: () => context.go('/payments'),
          ),
        ] else ...[
          const SizedBox(height: 10),
          Text(
            tr(ref, 'Earnings and payments are switched off for your shop by Deligro.',
                'Deligro ने आपकी दुकान के लिए कमाई और भुगतान बंद किए हैं।'),
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
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusBlock), side: BorderSide(color: c.line)),
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
                    Text(name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
                    const SizedBox(height: 2),
                    Text(tr(ref, '$ordersToday orders today', 'आज $ordersToday ऑर्डर'), style: TextStyle(color: c.muted, fontSize: 13)),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(color: open ? c.greenSoft : c.surface2, borderRadius: BorderRadius.circular(999)),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(width: 7, height: 7, decoration: BoxDecoration(color: open ? c.green : c.muted, shape: BoxShape.circle)),
                    const SizedBox(width: 6),
                    Text(open ? tr(ref, 'Open', 'खुली') : tr(ref, 'Closed', 'बंद'),
                        style: TextStyle(color: open ? c.green : c.muted, fontWeight: FontWeight.w700, fontSize: 12.5)),
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
                    decoration: BoxDecoration(color: tint.withValues(alpha: .13), borderRadius: BorderRadius.circular(8)),
                    child: Icon(icon, size: 17, color: tint),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(label,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w600, height: 1.2)),
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
                Text(note!, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: c.muted, fontSize: 11.5)),
            ],
          ),
        ),
      ),
    );
  }
}

class _WideTile extends StatelessWidget {
  const _WideTile({required this.icon, required this.tint, required this.label, required this.value, required this.note, required this.onTap});
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
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusBlock), side: BorderSide(color: c.line)),
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
                    Text(label, style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w600)),
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
      if (m.pending > 0) tr(ref, '${m.pending} pending', '${m.pending} बाकी'),
      if (m.approved > 0) tr(ref, '${m.approved} approved', '${m.approved} मंज़ूर'),
      if (m.inProgress > 0) tr(ref, '${m.inProgress} running', '${m.inProgress} चालू'),
      if (m.completed > 0) tr(ref, '${m.completed} completed', '${m.completed} पूरे'),
      if (m.rejected > 0) tr(ref, '${m.rejected} rejected', '${m.rejected} अस्वीकार'),
    ];
    final summary = parts.isEmpty
        ? tr(ref, 'Ask Deligro to feature your shop or run a campaign', 'Deligro से अपनी दुकान फ़ीचर करवाएँ या कैंपेन चलवाएँ')
        : parts.join(' · ');
    return Material(
      color: c.surface,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusBlock), side: BorderSide(color: c.line)),
      child: ListTile(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusBlock)),
        leading: Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(12)),
          child: Icon(Icons.campaign_rounded, color: c.deal),
        ),
        title: Text(tr(ref, 'Marketing requests', 'मार्केटिंग अनुरोध'), style: const TextStyle(fontWeight: FontWeight.w700)),
        subtitle: Text(summary, maxLines: 2, overflow: TextOverflow.ellipsis),
        trailing: Icon(Icons.chevron_right_rounded, color: c.muted),
        onTap: () => context.push('/more/marketing'),
      ),
    );
  }
}
