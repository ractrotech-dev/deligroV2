import 'package:flutter/material.dart';

import '../../models/marketing.dart';
import '../../theme/app_theme.dart';

Color requestStatusColor(AppColors c, RequestStatus s) => switch (s) {
      RequestStatus.pending => c.pop,
      RequestStatus.approved || RequestStatus.inProgress => c.blue,
      RequestStatus.completed => c.green,
      RequestStatus.rejected => c.deal,
      RequestStatus.unknown => c.muted,
    };

Color campaignStateColor(AppColors c, CampaignState s, CampaignStatus status) {
  if (status == CampaignStatus.cancelled) return c.deal;
  return switch (s) {
    CampaignState.active => c.green,
    CampaignState.scheduled => c.blue,
    CampaignState.expired || CampaignState.unknown => c.muted,
  };
}

IconData campaignIcon(CampaignKind k) => switch (k) {
      CampaignKind.featuredStore => Icons.storefront_outlined,
      CampaignKind.banner => Icons.view_carousel_outlined,
      CampaignKind.seasonal => Icons.celebration_outlined,
      CampaignKind.sponsoredProduct => Icons.restaurant_menu_outlined,
      CampaignKind.unknown => Icons.campaign_outlined,
    };

IconData requestIcon(MarketingType t) => t.campaignKind != null
    ? campaignIcon(t.campaignKind!)
    : (t == MarketingType.discountOffer ? Icons.local_offer_outlined : Icons.campaign_outlined);

/// "Cancelled", or the state the window gives ("Active", "Scheduled", "Expired").
String campaignStateLabel(CampaignSummary c) => c.status == CampaignStatus.cancelled ? 'Cancelled' : c.state.label;

/// The message for a refused marketing action.
String marketingRefusal(String code, Map<String, dynamic> extra) => switch (code) {
      'stale' => 'Someone else changed this already. Showing the latest.',
      'slot_taken' =>
        'Slot ${extra['slot'] ?? ''} is taken by another campaign${extra['campaignId'] == null ? '' : ' (${extra['campaignId']})'} in those dates. Pick another slot.',
      'code_taken' => 'That offer code is already used. Pick another code.',
      'consent_required' => "Vendor-funded campaigns need the vendor's approved request.",
      'reason_required' => 'Give a reason of at least 3 characters.',
      'locked_field' => "That can't change once the campaign has started.",
      'invalid_transition' => "That step isn't possible from the request's current status.",
      'out_of_scope' => 'A shop, zone or dish is outside your zones.',
      'not_found' => "This isn't in your zones any more.",
      'permission_denied' || 'forbidden' => "You don't have permission to manage marketing.",
      'rate_limited' => 'Too many changes at once. Wait a moment and try again.',
      _ => "That didn't go through ($code).",
    };
