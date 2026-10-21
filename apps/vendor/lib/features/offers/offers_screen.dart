import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../core/format.dart';
import '../../models/growth.dart';
import '../../state/growth.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

/// Offers (requirements §9): the shop's own promo codes — live, scheduled,
/// paused or over — with what each brought in, and the Deligro-funded
/// promotions running at the shop. A bigger campaign is asked for through a
/// marketing request.
class OffersScreen extends ConsumerWidget {
  const OffersScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(offersProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Offers')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/more/offers/new'),
        icon: const Icon(Icons.add_rounded),
        label: const Text('New offer'),
      ),
      body: switch (async) {
        AsyncData(:final value) => RefreshIndicator(
          onRefresh: () => ref.refresh(offersProvider.future),
          child: _Body(state: value),
        ),
        AsyncError(:final error) => LoadFailed(error: error, onRetry: () => ref.invalidate(offersProvider)),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _Body extends ConsumerWidget {
  const _Body({required this.state});

  final OffersState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final live = state.own.where((o) => o.status == 'live' || o.status == 'scheduled').toList();
    final past = state.own.where((o) => o.status != 'live' && o.status != 'scheduled').toList();
    final orders = state.own.fold(0, (s, o) => s + o.impact.orders);
    final sales = state.own.fold(0, (s, o) => s + o.impact.sales);
    final given = state.own.fold(0, (s, o) => s + o.impact.discount);
    return ListView(
      padding: const EdgeInsets.only(bottom: 96),
      children: [
        const SizedBox(height: 8),
        Panel(
          child: TwoUp(
            children: [
              _Stat('Orders with your offers', '$orders'),
              _Stat('Sales from them', rupees(sales)),
              _Stat('Discount you gave', rupees(given)),
              _Stat('Cost to your earnings', rupees(state.own.fold(0, (s, o) => s + o.impact.earningsCost))),
              _Stat('Live now', '${state.own.where((o) => o.status == 'live').length}'),
            ],
          ),
        ),
        SectionHeading('Your offers'),
        if (live.isEmpty)
          Panel(
            child: Text(
              'No live offers. Create one — customers see it on your shop card.',
              style: TextStyle(color: c.muted),
            ),
          ),
        for (final o in live) _OfferTile(offer: o),
        if (past.isNotEmpty) ...[SectionHeading('Paused & finished'), for (final o in past) _OfferTile(offer: o)],
        SectionHeading('Deligro promotions at your shop'),
        if (state.platform.isEmpty)
          Panel(
            child: Text(
              'None running right now. Deligro pays for these; you don\'t lose anything.',
              style: TextStyle(color: c.muted),
            ),
          ),
        for (final p in state.platform) _PlatformTile(p: p),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 0),
          child: OutlinedButton.icon(
            onPressed: () => context.push('/more/marketing/new?kind=discount_offer'),
            icon: const Icon(Icons.campaign_outlined),
            label: const Text('Ask Deligro for a bigger campaign'),
          ),
        ),
      ],
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: TextStyle(color: context.colors.muted, fontSize: 12.5)),
      const SizedBox(height: 2),
      Text(value, style: dataStyle(context, size: 17, weight: FontWeight.w800)),
    ],
  );
}

final _day = DateFormat('d MMM', 'en_IN');

String offerWhen(Offer o) {
  if (o.status == 'scheduled' && o.startsAt != null) return 'Starts ${_day.format(o.startsAt!)}';
  if (o.expiresAt != null) {
    return o.status == 'expired' ? 'Ended ${_day.format(o.expiresAt!)}' : 'Until ${_day.format(o.expiresAt!)}';
  }
  return 'No end date';
}

class _OfferTile extends ConsumerWidget {
  const _OfferTile({required this.offer});

  final Offer offer;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final o = offer;
    final (fg, bg, word) = switch (o.status) {
      'live' => (c.green, c.greenSoft, 'Live'),
      'scheduled' => (c.blue, c.surface2, 'Scheduled'),
      'paused' => (c.muted, c.surface2, 'Paused'),
      'used_up' => (c.deal, c.dealSoft, 'Used up'),
      _ => (c.muted, c.surface2, 'Ended'),
    };
    final canToggle = o.status == 'live' || o.status == 'scheduled' || o.status == 'paused';
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Panel(
        padding: const EdgeInsets.fromLTRB(16, 14, 8, 12),
        child: InkWell(
          onTap: () => context.push('/more/offers/edit', extra: o),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(o.code, style: dataStyle(context, size: 15, weight: FontWeight.w800)),
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(99)),
                          child: Text(
                            word,
                            style: TextStyle(color: fg, fontSize: 11.5, fontWeight: FontWeight.w700),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(o.headline, style: const TextStyle(fontWeight: FontWeight.w700)),
                    Text(
                      '${offerWhen(o)} · used ${o.redemptions}${o.maxRedemptions == null ? '' : '/${o.maxRedemptions}'}',
                      style: TextStyle(color: c.muted, fontSize: 12.5),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      '${o.impact.orders} orders · ${rupees(o.impact.sales)} sales · ${rupees(o.impact.discount)} given',
                      style: TextStyle(color: c.ink, fontSize: 12.5, fontWeight: FontWeight.w600),
                    ),
                    Text(
                      'Funded by you · cost to your earnings ${rupees(o.impact.earningsCost)}',
                      style: TextStyle(color: c.muted, fontSize: 12),
                    ),
                  ],
                ),
              ),
              if (canToggle)
                Switch(
                  value: o.active,
                  onChanged: (v) async {
                    final ok = await runWrite(
                      context,
                      ref,
                      () => ref.read(growthRepoProvider).setOfferActive(o.code, v),
                      done: v ? 'Offer resumed' : 'Offer paused',
                    );
                    if (ok) ref.invalidate(offersProvider);
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlatformTile extends StatelessWidget {
  const _PlatformTile({required this.p});

  final PlatformOffer p;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final o = p.offer;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Panel(
        tint: c.accentSoft,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(o.code, style: dataStyle(context, size: 15, weight: FontWeight.w800)),
                const SizedBox(width: 8),
                Text(
                  p.shopOnly ? 'Only at your shop' : 'Every shop',
                  style: TextStyle(color: c.accentInk, fontSize: 12, fontWeight: FontWeight.w700),
                ),
              ],
            ),
            const SizedBox(height: 4),
            Text(o.headline, style: const TextStyle(fontWeight: FontWeight.w700)),
            Text(
              '${offerWhen(o)} · funded by Deligro · no cost to you',
              style: TextStyle(color: c.muted, fontSize: 12.5),
            ),
            const SizedBox(height: 4),
            Text(
              '${o.impact.orders} orders at your shop · ${rupees(o.impact.sales)} sales',
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
            ),
          ],
        ),
      ),
    );
  }
}
