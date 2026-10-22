import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../models/marketing.dart';
import '../../theme/app_theme.dart';
import 'form_bits.dart';

/// Edits a [CampaignInput]: the fields shift with the kind (a slot for a
/// featured store, banner text for banner and seasonal campaigns, dishes for
/// sponsored products), a share when funding is shared.
///
/// Used by the request decide screen (pre-filled from the request) and the
/// campaign form. [lockVendor] keeps the shop a request named; [windowOnly]
/// is a started campaign, where only the end, budget, notes and banner move.
class CampaignFields extends ConsumerWidget {
  const CampaignFields({
    super.key,
    required this.value,
    required this.onChanged,
    this.errors = const {},
    this.vendorNames = const {},
    this.itemNames = const {},
    this.onNames,
    this.lockKind = false,
    this.lockVendor = false,
    this.windowOnly = false,
    this.lockFunding = false,
  });

  final CampaignInput value;
  final ValueChanged<CampaignInput> onChanged;
  final Map<String, String> errors;

  /// Display names for the ids in [value] (pickers report new ones via [onNames]).
  final Map<String, String> vendorNames;
  final Map<String, String> itemNames;
  final void Function(Map<String, String> vendors, Map<String, String> items)? onNames;
  final bool lockKind;
  final bool lockVendor;
  final bool windowOnly;

  /// Vendor/shared funding needs the vendor's approved request; a campaign
  /// made without one is Deligro-funded and the choice is fixed.
  final bool lockFunding;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final v = value;
    final early = !windowOnly;
    final zones = myZones(ref);
    String names(List<String> ids, Map<String, String> m) => [for (final id in ids) m[id] ?? 'Selected'].join(', ');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!lockKind)
          FormSection(title: 'Type', children: [
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final k in CampaignKind.pickable)
                ChoiceChip(
                  key: Key('kind-${k.wire}'),
                  label: Text(k.label),
                  selected: v.kind == k,
                  onSelected: early ? (_) => onChanged(v.copyWith(kind: k)) : null,
                ),
            ]),
          ]),
        FormSection(title: 'Campaign', children: [
          TextFormField(
            key: const Key('campaign-title'),
            initialValue: v.title,
            enabled: early,
            maxLength: 80,
            decoration: InputDecoration(labelText: 'Title', errorText: errors['title']),
            onChanged: (t) => onChanged(v.copyWith(title: t)),
          ),
          const SizedBox(height: 8),
          if (zones.length > 1 && !lockVendor)
            DropdownButtonFormField<String>(
              key: const Key('campaign-zone'),
              initialValue: zones.any((z) => z.id == v.zoneId) ? v.zoneId : null,
              decoration: const InputDecoration(labelText: 'Zone'),
              items: [for (final z in zones) DropdownMenuItem(value: z.id, child: Text(z.name))],
              onChanged: early ? (id) => id == null ? null : onChanged(v.copyWith(zoneId: id)) : null,
            ),
          if (v.kind == CampaignKind.featuredStore || v.kind == CampaignKind.sponsoredProduct || v.kind == CampaignKind.banner)
            PickedRow(
              key: const Key('campaign-vendor'),
              label: v.kind == CampaignKind.banner ? 'Shop (optional)' : 'Shop',
              value: names(v.vendorIds, vendorNames),
              errorText: errors['vendorIds'],
              onTap: lockVendor || !early
                  ? null
                  : () async {
                      final picked = await pickVendors(context, selected: v.vendorIds);
                      if (picked == null || picked.isEmpty) return;
                      onNames?.call({for (final p in picked) p.id: p.name}, const {});
                      onChanged(v.copyWith(vendorIds: [picked.first.id], itemIds: const []));
                    },
            ),
          if (v.kind == CampaignKind.seasonal)
            PickedRow(
              key: const Key('campaign-vendors'),
              label: 'Shops (optional, up to 50)',
              value: names(v.vendorIds, vendorNames),
              errorText: errors['vendorIds'],
              onTap: !early
                  ? null
                  : () async {
                      final picked = await pickVendors(context, selected: v.vendorIds, multi: true, max: 50);
                      if (picked == null) return;
                      onNames?.call({for (final p in picked) p.id: p.name}, const {});
                      onChanged(v.copyWith(vendorIds: [for (final p in picked) p.id]));
                    },
            ),
          if (v.kind == CampaignKind.sponsoredProduct)
            PickedRow(
              key: const Key('campaign-dishes'),
              label: 'Dishes (1–20)',
              value: v.itemIds.isEmpty ? '' : '${v.itemIds.length} dish${v.itemIds.length == 1 ? '' : 'es'}: ${names(v.itemIds, itemNames)}',
              errorText: errors['itemIds'],
              onTap: !early || v.vendorIds.isEmpty
                  ? null
                  : () async {
                      final picked = await pickDishes(context, vendorId: v.vendorIds.first, selected: v.itemIds);
                      if (picked == null) return;
                      onNames?.call(const {}, {for (final p in picked) p.id: p.name});
                      onChanged(v.copyWith(itemIds: [for (final p in picked) p.id]));
                    },
            ),
        ]),
        if (v.kind == CampaignKind.featuredStore)
          FormSection(title: 'Slot on the home feed', children: [
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (var s = 1; s <= 10; s++)
                ChoiceChip(
                  key: Key('slot-$s'),
                  label: Text('$s'),
                  selected: v.slotPosition == s,
                  onSelected: early ? (_) => onChanged(v.copyWith(slotPosition: s)) : null,
                ),
            ]),
            if (errors['slotPosition'] != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(errors['slotPosition']!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12.5)),
              ),
          ]),
        FormSection(title: 'Dates', children: [
          IstDateTimeField(
            key: const Key('campaign-start'),
            label: 'Starts',
            value: v.startsAt,
            enabled: early,
            errorText: errors['startsAt'],
            onChanged: (d) => onChanged(v.copyWith(startsAt: d)),
          ),
          const SizedBox(height: 10),
          IstDateTimeField(
            key: const Key('campaign-end'),
            label: 'Ends',
            value: v.endsAt,
            endOfDay: true,
            errorText: errors['endsAt'],
            onChanged: (d) => onChanged(v.copyWith(endsAt: d)),
          ),
        ]),
        FormSection(title: 'Budget and funding', children: [
          IntField(
            key: const Key('campaign-budget'),
            label: 'Budget (record only)',
            prefix: '₹ ',
            value: v.budget,
            errorText: errors['budget'],
            helper: 'Recorded for the campaign; nothing is charged.',
            onChanged: (n) => onChanged(v.copyWith(budget: n)),
          ),
          const SizedBox(height: 10),
          Wrap(spacing: 8, children: [
            for (final f in Funding.pickable)
              ChoiceChip(
                key: Key('funding-${f.wire}'),
                label: Text(f == Funding.deligro ? 'Deligro pays' : f == Funding.vendor ? 'Vendor pays' : 'Shared'),
                selected: v.fundedBy == f,
                onSelected: !early || (lockFunding && f != Funding.deligro)
                    ? null
                    : (_) => onChanged(v.copyWith(fundedBy: f, vendorSharePct: f == Funding.shared ? (v.vendorSharePct ?? 50) : null)),
              ),
          ]),
          if (lockFunding)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                "Vendor or shared funding needs that vendor's approved request — approve it from Requests.",
                style: TextStyle(fontSize: 12.5, color: context.colors.muted),
              ),
            ),
          if (v.fundedBy == Funding.shared) ...[
            const SizedBox(height: 8),
            Text(
              "Vendor's share: ${v.vendorSharePct ?? 50}%  ·  Deligro: ${100 - (v.vendorSharePct ?? 50)}%",
              key: const Key('share-label'),
              style: dataStyle(context, size: 13),
            ),
            Slider(
              key: const Key('share-slider'),
              min: 1,
              max: 99,
              divisions: 98,
              value: (v.vendorSharePct ?? 50).toDouble(),
              onChanged: early ? (x) => onChanged(v.copyWith(vendorSharePct: x.round())) : null,
            ),
            if (errors['vendorSharePct'] != null)
              Text(errors['vendorSharePct']!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12.5)),
            if (v.budget != null)
              Text(
                'Vendor ${rupees(v.budget! * (v.vendorSharePct ?? 50) / 100)} · Deligro ${rupees(v.budget! * (100 - (v.vendorSharePct ?? 50)) / 100)}',
                style: TextStyle(fontSize: 12.5, color: context.colors.muted),
              ),
          ],
        ]),
        if (v.kind.hasBanner) _BannerFields(value: v, errors: errors, onChanged: onChanged),
        if (v.kind == CampaignKind.seasonal)
          FormSection(title: 'Linked offer (optional)', children: [
            TextFormField(
              key: const Key('campaign-offer'),
              initialValue: v.offerCode ?? '',
              enabled: early,
              textCapitalization: TextCapitalization.characters,
              decoration: InputDecoration(
                labelText: 'Offer code',
                helperText: "An existing offer in your zones; its validity becomes the campaign's dates.",
                errorText: errors['offerCode'],
              ),
              onChanged: (t) => onChanged(v.copyWith(offerCode: t.trim().isEmpty ? null : t.trim().toUpperCase())),
            ),
          ]),
        FormSection(title: 'Notes', children: [
          TextFormField(
            key: const Key('campaign-notes'),
            initialValue: v.notes ?? '',
            maxLines: 3,
            decoration: const InputDecoration(labelText: 'Notes (optional)'),
            onChanged: (t) => onChanged(v.copyWith(notes: t)),
          ),
        ]),
      ],
    );
  }
}

class _BannerFields extends StatelessWidget {
  const _BannerFields({required this.value, required this.errors, required this.onChanged});
  final CampaignInput value;
  final Map<String, String> errors;
  final ValueChanged<CampaignInput> onChanged;

  @override
  Widget build(BuildContext context) {
    final b = value.banner ?? const BannerFields();
    void set(BannerFields n) => onChanged(value.copyWith(banner: n));
    return FormSection(title: 'Banner', children: [
      TextFormField(
        key: const Key('banner-headline'),
        initialValue: b.headline,
        maxLength: 60,
        decoration: InputDecoration(labelText: 'Headline', errorText: errors['headline']),
        onChanged: (t) => set(b.copyWith(headline: t)),
      ),
      TextFormField(
        key: const Key('banner-description'),
        initialValue: b.description,
        maxLength: 140,
        decoration: InputDecoration(labelText: 'Description (optional)', errorText: errors['description']),
        onChanged: (t) => set(b.copyWith(description: t)),
      ),
      TextFormField(
        key: const Key('banner-cta'),
        initialValue: b.ctaLabel,
        maxLength: 20,
        decoration: InputDecoration(labelText: 'Button text', errorText: errors['ctaLabel']),
        onChanged: (t) => set(b.copyWith(ctaLabel: t)),
      ),
      DropdownButtonFormField<String>(
        key: const Key('banner-target'),
        initialValue: const ['restaurant', 'product', 'category', 'food', 'external'].contains(b.targetType) ? b.targetType : 'restaurant',
        decoration: const InputDecoration(labelText: 'Tapping it opens'),
        items: const [
          DropdownMenuItem(value: 'restaurant', child: Text('A shop')),
          DropdownMenuItem(value: 'product', child: Text('A dish')),
          DropdownMenuItem(value: 'category', child: Text('A category')),
          DropdownMenuItem(value: 'food', child: Text('A food search')),
          DropdownMenuItem(value: 'external', child: Text('A web link')),
        ],
        onChanged: (t) => t == null ? null : set(b.copyWith(targetType: t)),
      ),
      TextFormField(
        key: const Key('banner-target-value'),
        initialValue: b.targetValue ?? '',
        decoration: InputDecoration(
          labelText: b.targetType == 'external' ? 'Link (https://…)' : 'Slug (optional)',
          errorText: errors['targetValue'],
        ),
        onChanged: (t) => set(b.copyWith(targetValue: t.trim().isEmpty ? null : t.trim())),
      ),
      const SizedBox(height: 12),
      BannerPreview(banner: b),
    ]);
  }
}

/// The banner as a customer would see it, in our tokens.
class BannerPreview extends StatelessWidget {
  const BannerPreview({super.key, required this.banner});
  final BannerFields banner;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final img = banner.imageUrl;
    return Container(
      key: const Key('banner-preview'),
      constraints: const BoxConstraints(minHeight: 120),
      decoration: BoxDecoration(
        color: c.accentSoft,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      clipBehavior: Clip.antiAlias,
      child: Row(
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    banner.headline.isEmpty ? 'Headline' : banner.headline,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: c.accentInk),
                  ),
                  if (banner.description.isNotEmpty)
                    Text(banner.description, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, color: c.ink)),
                  const SizedBox(height: 6),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                    decoration: BoxDecoration(color: c.accent, borderRadius: BorderRadius.circular(999)),
                    child: Text(banner.ctaLabel.isEmpty ? 'Order now' : banner.ctaLabel,
                        style: TextStyle(color: c.onAccent, fontSize: 12, fontWeight: FontWeight.w700)),
                  ),
                ],
              ),
            ),
          ),
          if (img != null)
            SizedBox(
              width: 120,
              height: 120,
              child: Image.network(img, fit: BoxFit.cover, errorBuilder: (_, _, _) => Icon(Icons.image_not_supported_outlined, color: c.muted)),
            )
          else
            SizedBox(width: 90, child: Icon(Icons.image_outlined, size: 36, color: c.muted)),
        ],
      ),
    );
  }
}
