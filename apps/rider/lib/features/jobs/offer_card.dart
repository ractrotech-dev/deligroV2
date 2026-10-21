import 'package:flutter/material.dart';

import '../../core/format.dart';
import '../../models/jobs.dart';
import '../../theme/app_theme.dart';
import 'countdown_ring.dart';

/// Where an offer stands at [now]: held for this rider with time left on its
/// exclusive window, or open to every online rider (never held, or the window
/// has run out).
class OfferTiming {
  const OfferTiming._(this.left);

  /// Time left of the exclusive window; null when the offer is open.
  final Duration? left;

  bool get held => left != null;

  factory OfferTiming.of(RiderOffer offer, DateTime now) {
    final until = offer.offerExpiresAt;
    if (!offer.reservedForYou || until == null) return const OfferTiming._(null);
    final left = until.difference(now);
    return OfferTiming._(left > Duration.zero ? left : null);
  }
}

String _km(double km) => '${km.toStringAsFixed(1)} km';

String _items(int n) => n == 1 ? '1 item' : '$n items';

/// "Held for you" or "Open to everyone", in words and an icon, not colour alone.
class OfferChip extends StatelessWidget {
  const OfferChip({super.key, required this.held});

  final bool held;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (bg, fg, icon, text) = held
        ? (c.greenSoft, c.green, Icons.lock_clock_rounded, 'Held for you')
        : (c.surface2, c.muted, Icons.public_rounded, 'Open to everyone');
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: fg),
          const SizedBox(width: 6),
          Flexible(
            child: Text(text, style: TextStyle(color: fg, fontWeight: FontWeight.w800, fontSize: 13)),
          ),
        ],
      ),
    );
  }
}

/// Cash to take at the door, or that nothing is owed, or that the server could
/// not tell (never shown as a demand for money).
class PaymentBanner extends StatelessWidget {
  const PaymentBanner({super.key, required this.payment});

  final RiderPayment payment;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (bg, fg, icon, text) = switch (payment.instruction) {
      CashInstruction.collect => (
          c.pop,
          c.popInk,
          Icons.payments_rounded,
          'Collect ${rupees(payment.collectAmount)} cash',
        ),
      CashInstruction.prepaid => (c.greenSoft, c.green, Icons.check_circle_rounded, 'Prepaid'),
      CashInstruction.unconfirmed => (c.surface2, c.muted, Icons.help_outline_rounded, 'Payment not confirmed'),
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
      child: Row(
        children: [
          Icon(icon, size: 20, color: fg),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(color: fg, fontWeight: FontWeight.w800, fontSize: 16)),
          ),
        ],
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact(this.icon, this.text);

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 16, color: c.muted),
        const SizedBox(width: 4),
        Flexible(child: Text(text, style: TextStyle(color: c.ink, fontSize: 14, fontWeight: FontWeight.w600))),
      ],
    );
  }
}

List<Widget> _facts(RiderOffer o) => [
      _Fact(Icons.shopping_bag_outlined, _items(o.itemCount)),
      if (o.shopToDropKm != null) _Fact(Icons.route_rounded, '${_km(o.shopToDropKm!)} shop to drop'),
      if (o.riderToShopKm != null) _Fact(Icons.near_me_outlined, '${_km(o.riderToShopKm!)} to the shop'),
      if (o.etaMinutes != null) _Fact(Icons.schedule_rounded, 'ETA ${o.etaMinutes} min'),
    ];

class _StopLine extends StatelessWidget {
  const _StopLine({required this.icon, required this.label, required this.line});

  final IconData icon;
  final String label;
  final String? line;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final text = (line ?? '').trim();
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 22, color: c.accentInk),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: Theme.of(context).textTheme.labelSmall),
              Text(
                text.isEmpty ? 'Address not shared yet' : text,
                style: TextStyle(fontSize: 15.5, height: 1.3, fontWeight: FontWeight.w600, color: text.isEmpty ? c.muted : c.ink),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// The first offer, in full: everything a rider needs to say yes or no without
/// opening anything. [now] drives the countdown (the screen ticks it).
class OfferCard extends StatelessWidget {
  const OfferCard({
    super.key,
    required this.offer,
    required this.now,
    required this.windowSeconds,
    required this.busy,
    required this.onAccept,
    required this.onReject,
  });

  final RiderOffer offer;
  final DateTime now;
  final int windowSeconds;

  /// An answer is on its way for some offer; buttons wait.
  final bool busy;
  final VoidCallback onAccept;
  final VoidCallback onReject;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final timing = OfferTiming.of(offer, now);
    final held = timing.held;
    final instructions = (offer.instructions ?? '').trim();
    return Container(
      key: Key('offer-card-${offer.orderId}'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: held ? c.surface : c.surface2,
        borderRadius: BorderRadius.circular(radiusSheet),
        border: Border.all(color: held ? c.green : c.line, width: held ? 2.5 : 1.5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    OfferChip(held: held),
                    const SizedBox(height: 8),
                    Text(offer.code, style: dataStyle(context, size: 13).copyWith(color: c.muted)),
                  ],
                ),
              ),
              if (held) ...[
                const SizedBox(width: 12),
                KeyedSubtree(
                  key: Key('countdown-${offer.orderId}'),
                  child: CountdownRing(left: timing.left!, total: Duration(seconds: windowSeconds)),
                ),
              ],
            ],
          ),
          const SizedBox(height: 14),
          Text(offer.shop.name, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 14),
          _StopLine(icon: Icons.storefront_rounded, label: 'PICKUP', line: offer.shop.line),
          const SizedBox(height: 10),
          _StopLine(icon: Icons.location_on_rounded, label: 'DROP', line: offer.drop.line),
          if (instructions.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(color: c.accentSoft, borderRadius: BorderRadius.circular(10)),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.sticky_note_2_outlined, size: 18, color: c.accentInk),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(instructions, style: TextStyle(color: c.accentInk, fontWeight: FontWeight.w600)),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 14),
          Wrap(spacing: 16, runSpacing: 8, children: _facts(offer)),
          const SizedBox(height: 14),
          PaymentBanner(payment: offer.payment),
          if (offer.estimatedEarning != null) ...[
            const SizedBox(height: 10),
            Row(
              children: [
                Icon(Icons.account_balance_wallet_outlined, size: 18, color: c.muted),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Estimated earning ${rupees(offer.estimatedEarning!)}',
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: 16),
          FilledButton(
            key: Key('accept-${offer.orderId}'),
            onPressed: busy ? null : onAccept,
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(60)),
            child: busy
                ? SizedBox(
                    width: 24,
                    height: 24,
                    child: CircularProgressIndicator(strokeWidth: 3, color: c.onAccent),
                  )
                : const Text('Accept'),
          ),
          if (held) ...[
            const SizedBox(height: 10),
            OutlinedButton(
              key: Key('reject-${offer.orderId}'),
              onPressed: busy ? null : onReject,
              style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(52)),
              child: const Text('Reject'),
            ),
          ],
        ],
      ),
    );
  }
}

/// Every offer after the first: the same answer in less room.
class OfferRow extends StatelessWidget {
  const OfferRow({
    super.key,
    required this.offer,
    required this.now,
    required this.busy,
    required this.onAccept,
    required this.onReject,
  });

  final RiderOffer offer;
  final DateTime now;
  final bool busy;
  final VoidCallback onAccept;
  final VoidCallback onReject;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final timing = OfferTiming.of(offer, now);
    final held = timing.held;
    final pay = switch (offer.payment.instruction) {
      CashInstruction.collect => 'Collect ${rupees(offer.payment.collectAmount)}',
      CashInstruction.prepaid => 'Prepaid',
      CashInstruction.unconfirmed => 'Payment not confirmed',
    };
    return Container(
      key: Key('offer-row-${offer.orderId}'),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: held ? c.surface : c.surface2,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: held ? c.green : c.line, width: held ? 2 : 1),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Flexible(child: OfferChip(held: held)),
              const Spacer(),
              if (held)
                Text(
                  formatCountdown(timing.left!),
                  key: Key('countdown-${offer.orderId}'),
                  style: dataStyle(context, size: 15, weight: FontWeight.w800)
                      .copyWith(color: timing.left!.inSeconds < 30 ? c.deal : c.ink),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: Text(offer.shop.name, style: Theme.of(context).textTheme.titleMedium)),
              const SizedBox(width: 8),
              Text(offer.code, style: dataStyle(context, size: 12).copyWith(color: c.muted)),
            ],
          ),
          if ((offer.drop.line ?? '').isNotEmpty)
            Text(
              'To ${offer.drop.line}',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: c.muted, height: 1.3),
            ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 14,
            runSpacing: 4,
            children: [
              _Fact(Icons.shopping_bag_outlined, _items(offer.itemCount)),
              if (offer.shopToDropKm != null) _Fact(Icons.route_rounded, _km(offer.shopToDropKm!)),
              _Fact(Icons.payments_outlined, pay),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              if (held) ...[
                Expanded(
                  child: OutlinedButton(
                    key: Key('reject-${offer.orderId}'),
                    onPressed: busy ? null : onReject,
                    child: const Text('Reject'),
                  ),
                ),
                const SizedBox(width: 10),
              ],
              Expanded(
                child: FilledButton(
                  key: Key('accept-${offer.orderId}'),
                  onPressed: busy ? null : onAccept,
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(48)),
                  child: const Text('Accept'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// A pickup the kitchen is still cooking: when it will be ready, and where it
/// goes. Not acceptable yet, so there are no buttons.
class UpcomingRow extends StatelessWidget {
  const UpcomingRow({super.key, required this.upcoming});

  final RiderUpcoming upcoming;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final o = upcoming.offer;
    final ready = upcoming.readyInMinutes;
    return Container(
      key: Key('upcoming-${o.orderId}'),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(color: c.accentSoft, shape: BoxShape.circle),
            child: Icon(Icons.soup_kitchen_outlined, color: c.accentInk),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(o.shop.name, style: Theme.of(context).textTheme.titleMedium),
                Text(
                  ready == null ? 'Being prepared' : 'Cooking · ready in ~$ready min',
                  style: TextStyle(color: c.accentInk, fontWeight: FontWeight.w700),
                ),
                if (o.riderToShopKm != null || o.shopToDropKm != null)
                  Text(
                    [
                      if (o.riderToShopKm != null) '${_km(o.riderToShopKm!)} to the shop',
                      if (o.shopToDropKm != null) '${_km(o.shopToDropKm!)} to the drop',
                    ].join(' · '),
                    style: TextStyle(color: c.muted, fontSize: 13.5),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
