import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/offers.dart';
import '../../theme/app_theme.dart';
import '../marketing/form_bits.dart';

/// What's wrong with [t] before it is sent, field → message (§9.2–9.5).
Map<String, String> offerProblems(OfferTerms t, {DateTime? now, bool creating = true}) {
  final out = <String, String>{};
  final at = (now ?? DateTime.now()).toUtc();
  if (creating && !RegExp(r'^[A-Z0-9]{3,20}$').hasMatch(t.code)) out['code'] = 'Use 3–20 letters A–Z or digits';
  if (t.kind == OfferKind.percent && (t.value < 1 || t.value > 90)) out['value'] = 'A percentage must be 1–90';
  if (t.kind == OfferKind.flat && t.value < 1) out['value'] = 'Enter the rupees off';
  if (t.minOrder < 0) out['minOrder'] = "Can't be negative";
  if (t.maxDiscount != null && t.maxDiscount! < 1) out['maxDiscount'] = 'Leave empty for no cap';
  final exp = t.expiresAt;
  if (exp == null) {
    out['expiresAt'] = 'Every offer needs an expiry';
  } else if (exp.isAfter(at.add(const Duration(days: 366)))) {
    out['expiresAt'] = 'At most a year ahead';
  } else if (t.startsAt != null && !exp.isAfter(t.startsAt!)) {
    out['expiresAt'] = 'The expiry must be after the start';
  }
  if (t.maxPerCustomer != null && t.maxPerCustomer! < 1) out['maxPerCustomer'] = 'At least 1, or empty';
  if (t.maxRedemptions != null && t.maxRedemptions! < 1) out['maxRedemptions'] = 'At least 1, or empty';
  if (t.itemIds.isNotEmpty && t.vendorIds.isEmpty) out['itemIds'] = 'Pick the shop the dishes belong to';
  return out;
}

/// Edits [OfferTerms]. [lockCode] once created; [lockFunding] unless the
/// offer comes from a vendor's approved request (vendor-funded needs consent).
class OfferFields extends ConsumerWidget {
  const OfferFields({
    super.key,
    required this.value,
    required this.onChanged,
    this.errors = const {},
    this.vendorNames = const {},
    this.itemNames = const {},
    this.zoneNames = const {},
    this.onNames,
    this.lockCode = false,
    this.lockFunding = true,
    this.lockVendors = false,
  });

  final OfferTerms value;
  final ValueChanged<OfferTerms> onChanged;
  final Map<String, String> errors;
  final Map<String, String> vendorNames;
  final Map<String, String> itemNames;
  final Map<String, String> zoneNames;
  final void Function(Map<String, String> vendors, Map<String, String> items)? onNames;
  final bool lockCode;
  final bool lockFunding;
  final bool lockVendors;

  OfferTerms _with(OfferTerms t, {
    String? code,
    Object? label = _u,
    OfferKind? kind,
    int? value,
    int? minOrder,
    Object? maxDiscount = _u,
    Object? startsAt = _u,
    Object? expiresAt = _u,
    Object? maxPerCustomer = _u,
    Object? maxRedemptions = _u,
    List<String>? vendorIds,
    List<String>? zoneIds,
    List<String>? itemIds,
    OfferFunding? fundedBy,
  }) =>
      OfferTerms(
        code: code ?? t.code,
        label: identical(label, _u) ? t.label : label as String?,
        kind: kind ?? t.kind,
        value: value ?? t.value,
        minOrder: minOrder ?? t.minOrder,
        maxDiscount: identical(maxDiscount, _u) ? t.maxDiscount : maxDiscount as int?,
        startsAt: identical(startsAt, _u) ? t.startsAt : startsAt as DateTime?,
        expiresAt: identical(expiresAt, _u) ? t.expiresAt : expiresAt as DateTime?,
        maxPerCustomer: identical(maxPerCustomer, _u) ? t.maxPerCustomer : maxPerCustomer as int?,
        maxRedemptions: identical(maxRedemptions, _u) ? t.maxRedemptions : maxRedemptions as int?,
        vendorIds: vendorIds ?? t.vendorIds,
        zoneIds: zoneIds ?? t.zoneIds,
        itemIds: itemIds ?? t.itemIds,
        fundedBy: fundedBy ?? t.fundedBy,
        requestId: t.requestId,
      );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = value;
    final zones = myZones(ref);
    final zoneLabel = {for (final z in zones) z.id: z.name, ...zoneNames};
    String names(List<String> ids, Map<String, String> m) => [for (final id in ids) m[id] ?? 'Selected'].join(', ');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FormSection(title: 'Code', children: [
          TextFormField(
            key: const Key('offer-code'),
            initialValue: t.code,
            enabled: !lockCode,
            textCapitalization: TextCapitalization.characters,
            maxLength: 20,
            decoration: InputDecoration(labelText: 'Code customers type', errorText: errors['code']),
            onChanged: (s) => onChanged(_with(t, code: s.trim().toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), ''))),
          ),
          TextFormField(
            key: const Key('offer-label'),
            initialValue: t.label ?? '',
            decoration: const InputDecoration(labelText: 'Label shown to customers (optional)'),
            onChanged: (s) => onChanged(_with(t, label: s.trim().isEmpty ? null : s.trim())),
          ),
        ]),
        FormSection(title: 'Discount', children: [
          SegmentedButton<OfferKind>(
            key: const Key('offer-kind'),
            segments: const [
              ButtonSegment(value: OfferKind.flat, label: Text('₹ off')),
              ButtonSegment(value: OfferKind.percent, label: Text('% off')),
            ],
            selected: {t.kind == OfferKind.percent ? OfferKind.percent : OfferKind.flat},
            onSelectionChanged: (s) => onChanged(_with(t, kind: s.first, maxDiscount: s.first == OfferKind.flat ? null : t.maxDiscount)),
          ),
          const SizedBox(height: 8),
          IntField(
            key: const Key('offer-value'),
            label: t.kind == OfferKind.percent ? 'Percent off' : 'Rupees off',
            prefix: t.kind == OfferKind.percent ? null : '₹ ',
            value: t.value == 0 ? null : t.value,
            errorText: errors['value'],
            onChanged: (n) => onChanged(_with(t, value: n ?? 0)),
          ),
          IntField(
            key: const Key('offer-min'),
            label: 'Minimum order',
            prefix: '₹ ',
            value: t.minOrder,
            errorText: errors['minOrder'],
            onChanged: (n) => onChanged(_with(t, minOrder: n ?? 0)),
          ),
          if (t.kind == OfferKind.percent)
            IntField(
              key: const Key('offer-cap'),
              label: 'Maximum discount (optional)',
              prefix: '₹ ',
              value: t.maxDiscount,
              errorText: errors['maxDiscount'],
              onChanged: (n) => onChanged(_with(t, maxDiscount: n)),
            ),
        ]),
        FormSection(title: 'Validity', children: [
          IstDateTimeField(
            key: const Key('offer-start'),
            label: 'Starts (optional — now if empty)',
            value: t.startsAt,
            onChanged: (d) => onChanged(_with(t, startsAt: d)),
          ),
          const SizedBox(height: 10),
          IstDateTimeField(
            key: const Key('offer-expiry'),
            label: 'Expires',
            value: t.expiresAt,
            endOfDay: true,
            errorText: errors['expiresAt'],
            onChanged: (d) => onChanged(_with(t, expiresAt: d)),
          ),
        ]),
        FormSection(title: 'Limits', children: [
          IntField(
            key: const Key('offer-per-customer'),
            label: 'Uses per customer (optional)',
            value: t.maxPerCustomer,
            errorText: errors['maxPerCustomer'],
            onChanged: (n) => onChanged(_with(t, maxPerCustomer: n)),
          ),
          IntField(
            key: const Key('offer-total'),
            label: 'Total uses (optional)',
            value: t.maxRedemptions,
            errorText: errors['maxRedemptions'],
            onChanged: (n) => onChanged(_with(t, maxRedemptions: n)),
          ),
        ]),
        FormSection(title: 'Where it applies', children: [
          PickedRow(
            key: const Key('offer-vendors'),
            label: 'Shops (empty = every shop in the zones)',
            value: names(t.vendorIds, vendorNames),
            onTap: lockVendors
                ? null
                : () async {
                    final picked = await pickVendors(context, selected: t.vendorIds, multi: true);
                    if (picked == null) return;
                    onNames?.call({for (final p in picked) p.id: p.name}, const {});
                    final ids = [for (final p in picked) p.id];
                    onChanged(_with(t, vendorIds: ids, itemIds: ids.length == 1 ? t.itemIds : const []));
                  },
          ),
          if (zones.length > 1 || t.zoneIds.isNotEmpty)
            Wrap(spacing: 8, children: [
              for (final z in zones)
                FilterChip(
                  key: Key('offer-zone-${z.id}'),
                  label: Text(z.name),
                  selected: t.zoneIds.contains(z.id),
                  onSelected: (on) => onChanged(_with(t, zoneIds: on ? [...t.zoneIds, z.id] : [...t.zoneIds]..remove(z.id))),
                ),
              for (final id in t.zoneIds)
                if (!zones.any((z) => z.id == id)) Chip(label: Text(zoneLabel[id] ?? 'Zone')),
            ]),
          if (zones.length == 1 && t.vendorIds.isEmpty && t.zoneIds.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('It will apply in ${zones.first.name}.', style: TextStyle(fontSize: 12.5, color: context.colors.muted)),
            ),
          PickedRow(
            key: const Key('offer-dishes'),
            label: 'Dishes (optional — one shop only)',
            value: t.itemIds.isEmpty ? '' : '${t.itemIds.length}: ${names(t.itemIds, itemNames)}',
            errorText: errors['itemIds'],
            onTap: t.vendorIds.length != 1
                ? null
                : () async {
                    final picked = await pickDishes(context, vendorId: t.vendorIds.first, selected: t.itemIds, max: 50);
                    if (picked == null) return;
                    onNames?.call(const {}, {for (final p in picked) p.id: p.name});
                    onChanged(_with(t, itemIds: [for (final p in picked) p.id]));
                  },
          ),
        ]),
        FormSection(title: 'Who pays the discount', children: [
          Wrap(spacing: 8, children: [
            for (final f in const [OfferFunding.platform, OfferFunding.vendor])
              ChoiceChip(
                key: Key('offer-funding-${f.name}'),
                label: Text(f == OfferFunding.platform ? 'Deligro pays' : 'Vendor pays'),
                selected: t.fundedBy == f,
                onSelected: lockFunding ? null : (_) => onChanged(_with(t, fundedBy: f)),
              ),
          ]),
          if (lockFunding)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                "A vendor-funded offer comes from that vendor's approved request.",
                style: TextStyle(fontSize: 12.5, color: context.colors.muted),
              ),
            ),
        ]),
      ],
    );
  }
}

const _u = Object();
