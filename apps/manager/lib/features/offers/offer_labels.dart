import 'package:flutter/material.dart';

import '../../core/format.dart';
import '../../models/offers.dart';
import '../../theme/app_theme.dart';

Color offerStateColor(AppColors c, OfferState s) => switch (s) {
      OfferState.active => c.green,
      OfferState.scheduled => c.blue,
      OfferState.exhausted => c.amberText,
      OfferState.expired || OfferState.inactive || OfferState.unknown => c.muted,
    };

/// Where an offer applies, in a line.
String offerScope(OfferSummary o) {
  if (o.platformWide) return 'Everywhere (only an admin can change it)';
  final parts = <String>[
    if (o.vendors.isNotEmpty) o.vendors.length <= 2 ? o.vendors.map((v) => v.name).join(', ') : '${o.vendors.length} shops',
    if (o.zones.isNotEmpty) o.zones.map((z) => z.name).join(', '),
    if (o.itemCount > 0) '${o.itemCount} dish${o.itemCount == 1 ? '' : 'es'}',
  ];
  return parts.join(' · ');
}

/// Field names in the change log, in words.
const offerFieldLabels = {
  'code': 'Code',
  'label': 'Label',
  'kind': 'Type',
  'value': 'Discount',
  'minOrder': 'Minimum order',
  'maxDiscount': 'Maximum discount',
  'startsAt': 'Starts',
  'expiresAt': 'Expires',
  'maxPerCustomer': 'Uses per customer',
  'maxRedemptions': 'Total uses',
  'fundedBy': 'Funded by',
  'active': 'Active',
  'vendor': 'Shop',
  'zone': 'Zone',
  'item': 'Dish',
};

String offerFieldLabel(String field) => offerFieldLabels[field] ?? field;

String offerRefusal(String code) => switch (code) {
      'expired' => 'Set a new expiry first.',
      'exhausted' => 'All its uses are taken. Raise the total uses first.',
      'stale' => 'Someone else changed this offer. Showing the latest.',
      'code_taken' => 'That code is already used. Pick another code.',
      'consent_required' => "A vendor-funded offer needs that vendor's approved request.",
      'out_of_scope' => 'A shop, zone or dish is outside your zones.',
      'platform_wide_admin_only' => 'An offer for everywhere can only be made by an admin. Pick shops or a zone.',
      'reason_required' => 'Give a reason of at least 3 characters.',
      'permission_denied' || 'forbidden' => "You don't have permission to manage offers.",
      'not_found' => "This offer isn't in your zones.",
      'rate_limited' => 'Too many changes at once. Wait a moment and try again.',
      _ => "That didn't go through ($code).",
    };

/// "₹50 off · min ₹199".
String offerTermsLine(OfferSummary o) => '${o.summary}${o.minOrder > 0 ? ' · min ${rupees(o.minOrder)}' : ''}';
