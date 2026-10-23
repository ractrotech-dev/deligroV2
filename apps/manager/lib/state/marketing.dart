import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/marketing_repository.dart';
import '../models/marketing.dart';
import '../models/outcome.dart';
import 'paged.dart';
import 'paged_list.dart';
import 'providers.dart';

/// Marketing (§8). Overridden with a fake in tests.
final marketingRepoProvider = Provider<MarketingRepository>((ref) => ApiMarketingRepository(ref.watch(apiProvider)));

typedef RequestList = Paged<MarketingRequest, RequestCounts>;
typedef CampaignList = Paged<CampaignSummary, CampaignCounts>;

class RequestListNotifier extends PagedListNotifier<MarketingRequest, RequestCounts> {
  RequestListNotifier(this.filters);
  final RequestFilters filters;

  @override
  Future<PageOf<MarketingRequest, RequestCounts>> fetch({String? cursor}) async {
    final p = await ref.read(marketingRepoProvider).requests(filters, cursor: cursor);
    return (items: p.items, next: p.nextCursor, counts: p.counts);
  }

  @override
  String idOf(MarketingRequest row) => row.id;
}

final requestListProvider = AsyncNotifierProvider.autoDispose.family<RequestListNotifier, RequestList, RequestFilters>(
  RequestListNotifier.new,
  retry: (_, _) => null,
);

class CampaignListNotifier extends PagedListNotifier<CampaignSummary, CampaignCounts> {
  CampaignListNotifier(this.filters);
  final CampaignFilters filters;

  @override
  Future<PageOf<CampaignSummary, CampaignCounts>> fetch({String? cursor}) async {
    final p = await ref.read(marketingRepoProvider).campaigns(filters, cursor: cursor);
    return (items: p.items, next: p.nextCursor, counts: p.counts);
  }

  @override
  String idOf(CampaignSummary row) => row.id;
}

final campaignListProvider = AsyncNotifierProvider.autoDispose.family<CampaignListNotifier, CampaignList, CampaignFilters>(
  CampaignListNotifier.new,
  retry: (_, _) => null,
);

/// One request with its campaign or offer. [decide] adopts what the server
/// returns; on a refusal it re-reads (someone else may have moved it).
class RequestDetailNotifier extends AsyncNotifier<RequestBundle> {
  RequestDetailNotifier(this.id);
  final String id;

  @override
  Future<RequestBundle> build() async {
    ref.watch(signedInProvider);
    return ref.read(marketingRepoProvider).request(id);
  }

  Future<void> refresh() async {
    if (!state.hasValue) {
      ref.invalidateSelf();
      return;
    }
    final next = await AsyncValue.guard(() => ref.read(marketingRepoProvider).request(id));
    if (next.hasValue) state = next;
  }

  /// Throws on a fault so the caller can retry the same decision.
  Future<Outcome<RequestBundle>> decide(RequestDecision d) async {
    final out = await ref.read(marketingRepoProvider).decide(id, d);
    switch (out) {
      case Applied(:final value?):
        state = AsyncData(value);
      case _:
        await refresh();
    }
    return out;
  }

  Future<Outcome<MarketingRequest>> progress(RequestProgress p) async {
    final out = await ref.read(marketingRepoProvider).progress(id, p);
    await refresh();
    return out;
  }
}

final requestDetailProvider = AsyncNotifierProvider.autoDispose.family<RequestDetailNotifier, RequestBundle, String>(
  RequestDetailNotifier.new,
  retry: (_, _) => null,
);

/// A campaign and its performance over a range (`from`/`to` IST dates, or
/// null for the window clipped to today).
typedef CampaignKey = ({String id, String? from, String? to});

class CampaignDetailNotifier extends AsyncNotifier<CampaignBundle> {
  CampaignDetailNotifier(this.key);
  final CampaignKey key;

  @override
  Future<CampaignBundle> build() async {
    ref.watch(signedInProvider);
    return ref.read(marketingRepoProvider).campaign(key.id, from: key.from, to: key.to);
  }

  Future<void> refresh() async {
    if (!state.hasValue) {
      ref.invalidateSelf();
      return;
    }
    final next = await AsyncValue.guard(() => ref.read(marketingRepoProvider).campaign(key.id, from: key.from, to: key.to));
    if (next.hasValue) state = next;
  }

  /// After an edit, cancel or end: keep the performance, take the new campaign.
  void adopt(CampaignDetail c) {
    final s = state.value;
    if (s != null) state = AsyncData(CampaignBundle(campaign: c, performance: s.performance));
  }
}

final campaignDetailProvider = AsyncNotifierProvider.autoDispose.family<CampaignDetailNotifier, CampaignBundle, CampaignKey>(
  CampaignDetailNotifier.new,
  retry: (_, _) => null,
);
