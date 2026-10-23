import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/format.dart';
import '../../models/offers.dart';
import '../../state/offers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/paged_list_view.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_labels.dart' show StatusText;
import 'offer_labels.dart';

/// Offers (§9): every promo code in this manager's zones by state, plus the
/// platform-wide ones (shown read-only).
class OffersScreen extends ConsumerStatefulWidget {
  const OffersScreen({super.key, this.query});
  final Uri? query;

  @override
  ConsumerState<OffersScreen> createState() => _OffersScreenState();
}

class _OffersScreenState extends ConsumerState<OffersScreen> {
  late OfferFilters _filters = OfferFilters(state: OfferState.parse(widget.query?.queryParameters['state']) == OfferState.unknown
      ? OfferState.active
      : OfferState.parse(widget.query?.queryParameters['state']));
  OfferCounts _counts = const OfferCounts();
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final zone = ref.watch(activeZoneProvider);
    final eff = _filters.zoneId != null || zone == null ? _filters : _filters.copyWith(zoneId: zone.id);
    final value = ref.watch(offerListProvider(eff));
    if (value.value != null) _counts = value.value!.counts;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Offers'),
        backgroundColor: c.bg,
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      floatingActionButton: FloatingActionButton.extended(
        key: const Key('offer-new'),
        backgroundColor: c.accent,
        foregroundColor: c.onAccent,
        elevation: 2,
        onPressed: () => GoRouter.maybeOf(context)?.push('/more/offers/new'),
        icon: const Icon(Icons.add),
        label: const Text('New offer'),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: TextField(
              key: const Key('offers-search'),
              textCapitalization: TextCapitalization.characters,
              decoration: InputDecoration(
                isDense: true,
                prefixIcon: const Icon(Icons.search),
                hintText: 'Code',
                filled: true,
                fillColor: c.surface,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(radiusBlock), borderSide: BorderSide(color: c.line)),
                enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(radiusBlock), borderSide: BorderSide(color: c.line)),
              ),
              onChanged: (t) {
                _debounce?.cancel();
                _debounce = Timer(const Duration(milliseconds: 400), () {
                  if (mounted) setState(() => _filters = _filters.copyWith(q: t.trim().isEmpty ? null : t.trim().toUpperCase()));
                });
              },
            ),
          ),
          CountChips<OfferState>(
            keyPrefix: 'offer-tab',
            options: [for (final s in OfferState.tabs) (s, s.label, _counts.of(s))],
            selected: _filters.state,
            allLabel: 'All',
            onSelected: (s) => setState(() => _filters = _filters.copyWith(state: s)),
          ),
          Expanded(
            child: PagedListView<OfferSummary, OfferCounts>(
              key: const Key('offers-list'),
              value: value,
              narrowed: true,
              filteredEmptyText: 'No offers here.',
              onRetry: () => ref.invalidate(offerListProvider(eff)),
              onRefresh: () => ref.read(offerListProvider(eff).notifier).refresh(),
              onLoadMore: () => ref.read(offerListProvider(eff).notifier).loadMore(),
              empty: const EmptySection(icon: Icons.local_offer_outlined, title: 'No offers', text: 'Create one with New offer.'),
              itemBuilder: (context, o) => OfferRow(
                offer: o,
                onTap: () => GoRouter.maybeOf(context)?.push('/more/offers/${Uri.encodeComponent(o.code)}'),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class OfferRow extends StatelessWidget {
  const OfferRow({super.key, required this.offer, required this.onTap});
  final OfferSummary offer;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final o = offer;
    final uses = o.maxRedemptions == null ? '${count(o.redemptions)} uses' : '${count(o.redemptions)} / ${count(o.maxRedemptions!)} uses';
    return RowCard(
      key: Key('offer-row-${o.code}'),
      onTap: onTap,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text(o.code, style: dataStyle(context, size: 15, weight: FontWeight.w800)),
          const SizedBox(width: 10),
          Expanded(child: Text(o.label ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: c.muted, fontSize: 13))),
          StatusText(o.state.label, color: offerStateColor(c, o.state)),
        ]),
        const SizedBox(height: 4),
        Text(offerTermsLine(o), style: TextStyle(color: c.ink, fontSize: 13.5)),
        const SizedBox(height: 2),
        Text(offerScope(o), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: c.muted, fontSize: 12.5)),
        const SizedBox(height: 6),
        Wrap(spacing: 14, runSpacing: 4, children: [
          Text(uses, style: dataStyle(context, size: 12)),
          Text('${rupees(o.discountGiven)} given', style: dataStyle(context, size: 12)),
          Text(o.fundedBy == OfferFunding.vendor ? 'Vendor pays' : 'Deligro pays', style: TextStyle(fontSize: 12, color: c.muted)),
          if (o.expiresAt != null) Text('Expires ${_short(o.expiresAt!)}', style: TextStyle(fontSize: 12, color: c.muted)),
        ]),
      ]),
    );
  }

  static String _short(DateTime at) {
    final ist = at.toUtc().add(const Duration(hours: 5, minutes: 30));
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${ist.day} ${m[ist.month - 1]}';
  }
}
