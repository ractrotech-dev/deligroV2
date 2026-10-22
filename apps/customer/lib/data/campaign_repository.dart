import '../core/api.dart';

/// Paid placements live right now (0160): featured shops with their feed
/// slot, and sponsored dishes. Read from `/api/campaigns/live` because the
/// catalog comes straight from the database and customers cannot read
/// campaigns there. Decided from each campaign's window by the server.
class LivePlacements {
  const LivePlacements({this.featured = const {}, this.sponsored = const {}});

  /// Restaurant id → (campaign id, slot 1–10).
  final Map<String, ({String campaignId, int slot})> featured;

  /// Menu item uuid → campaign id.
  final Map<String, String> sponsored;

  static const empty = LivePlacements();

  String? featuredFor(String restaurantId) => featured[restaurantId]?.campaignId;
  String? sponsoredFor(String menuItemUuid) => sponsored[menuItemUuid];

  factory LivePlacements.fromJson(Map<String, dynamic> j) {
    final featured = <String, ({String campaignId, int slot})>{};
    for (final f in (j['featured'] as List? ?? const [])) {
      final m = Map<String, dynamic>.from(f as Map);
      final slot = (m['slot'] as num?)?.toInt();
      if (m['restaurantId'] is String && m['campaignId'] is String && slot != null) {
        featured[m['restaurantId'] as String] = (campaignId: m['campaignId'] as String, slot: slot);
      }
    }
    final sponsored = <String, String>{};
    for (final s in (j['sponsored'] as List? ?? const [])) {
      final m = Map<String, dynamic>.from(s as Map);
      if (m['menuItemId'] is String && m['campaignId'] is String) sponsored[m['menuItemId'] as String] = m['campaignId'] as String;
    }
    return LivePlacements(featured: featured, sponsored: sponsored);
  }
}

/// The feed's slot layout with featured campaigns on top — the same rule as
/// the website's `effectiveVendorPositions`: each featured shop takes its slot;
/// pinned shops keep their slot unless displaced, then move down; past 10 drop.
Map<String, int> effectivePositions(Map<String, int> manual, Map<String, int> featuredSlots, {int slotCount = 10}) {
  final slots = List<String?>.filled(slotCount, null);
  final placed = <String>{};
  for (final e in featuredSlots.entries) {
    final i = e.value - 1;
    if (i < 0 || i >= slotCount || slots[i] != null || placed.contains(e.key)) continue;
    slots[i] = e.key;
    placed.add(e.key);
  }
  final rest = manual.entries.where((e) => !placed.contains(e.key)).toList()
    ..sort((a, b) => a.value != b.value ? a.value.compareTo(b.value) : a.key.compareTo(b.key));
  for (final e in rest) {
    var i = e.value - 1 < 0 ? 0 : e.value - 1;
    while (i < slotCount && slots[i] != null) {
      i++;
    }
    if (i >= slotCount) continue;
    slots[i] = e.key;
  }
  return {for (var i = 0; i < slotCount; i++) if (slots[i] != null) slots[i]!: i + 1};
}

class CampaignRepository {
  CampaignRepository(this._api);
  final ApiClient _api;

  Future<LivePlacements> live() async {
    try {
      return LivePlacements.fromJson(await _api.get('/api/campaigns/live'));
    } catch (_) {
      return LivePlacements.empty;
    }
  }

  /// Fire and forget: tracking never surfaces an error to the customer.
  Future<void> track(String campaignId, String kind, {String? itemId}) async {
    try {
      await _api.post('/api/campaigns/track', {'campaignId': campaignId, 'kind': kind, 'itemId': itemId});
    } catch (_) {}
  }
}
