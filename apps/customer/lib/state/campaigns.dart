import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/campaign_repository.dart';
import 'providers.dart';

final campaignRepoProvider = Provider((ref) => CampaignRepository(ref.watch(apiProvider)));

/// Live featured shops and sponsored dishes; empty when unreadable.
final livePlacementsProvider = FutureProvider<LivePlacements>((ref) => ref.watch(campaignRepoProvider).live());

/// One impression per campaign per app session, and every tap.
class CampaignTracker {
  CampaignTracker(this._repo);
  final CampaignRepository _repo;
  final _seen = <String>{};

  void impression(String campaignId, {String? itemId}) {
    if (!_seen.add('$campaignId:${itemId ?? ''}')) return;
    _repo.track(campaignId, 'impression', itemId: itemId);
  }

  void click(String campaignId, {String? itemId}) => _repo.track(campaignId, 'click', itemId: itemId);
}

final campaignTrackerProvider = Provider((ref) => CampaignTracker(ref.watch(campaignRepoProvider)));

/// Reports one impression for [campaignId] after its first frame on screen.
class CampaignImpression extends ConsumerStatefulWidget {
  const CampaignImpression({super.key, required this.campaignId, this.itemId, required this.child});
  final String? campaignId;
  final String? itemId;
  final Widget child;

  @override
  ConsumerState<CampaignImpression> createState() => _CampaignImpressionState();
}

class _CampaignImpressionState extends ConsumerState<CampaignImpression> {
  @override
  void initState() {
    super.initState();
    _report();
  }

  // The live placements usually arrive after the first frame: a card that
  // learns it is featured on a rebuild still reports (the tracker dedups).
  @override
  void didUpdateWidget(CampaignImpression old) {
    super.didUpdateWidget(old);
    if (widget.campaignId != old.campaignId) _report();
  }

  void _report() {
    final id = widget.campaignId;
    if (id == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(campaignTrackerProvider).impression(id, itemId: widget.itemId);
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
