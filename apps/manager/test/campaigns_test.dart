import 'package:deligro_manager/features/marketing/campaign_detail_screen.dart';
import 'package:deligro_manager/features/marketing/campaign_form_screen.dart';
import 'package:deligro_manager/models/marketing.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_marketing_offers_customers.dart';
import 'p7_helpers.dart';

CampaignDetail detailWith(Map<String, dynamic> patch) {
  final j = Map<String, dynamic>.from(p7('campaign_detail')['campaign'] as Map)..addAll(patch);
  return CampaignDetail.fromJson(j);
}

void main() {
  test('shared funding needs a share; a banner needs a headline', () {
    final base = CampaignInput(
      kind: CampaignKind.banner,
      title: 'Weekend',
      zoneId: 'z-1',
      startsAt: DateTime.utc(2026, 11, 1),
      endsAt: DateTime.utc(2026, 11, 2),
      fundedBy: Funding.shared,
    );
    final p = base.problems();
    expect(p['vendorSharePct'], isNotNull);
    expect(p['headline'], isNotNull);
    expect(base.copyWith(vendorSharePct: 40, banner: const BannerFields(headline: 'Hi')).problems(), isEmpty);
  });

  test('an edit never names the zone, the kind or the request', () {
    final before = CampaignInput(
      kind: CampaignKind.banner,
      title: 'Weekend',
      zoneId: 'z-1',
      startsAt: DateTime.utc(2026, 11, 1),
      endsAt: DateTime.utc(2026, 11, 2),
      fundedBy: Funding.deligro,
      banner: const BannerFields(headline: 'Hi'),
    );
    final moved = before.copyWith(zoneId: 'z-2', title: 'Weekend sale');
    final changes = campaignChanges(before, moved);
    expect(changes.keys, ['title']);
  });

  testWidgets('an end before the start disables Save', (tester) async {
    final input = CampaignInput(
      kind: CampaignKind.banner,
      title: 'Weekend',
      zoneId: 'z-1',
      startsAt: DateTime.utc(2026, 11, 5),
      endsAt: DateTime.utc(2026, 11, 2),
      fundedBy: Funding.deligro,
      banner: const BannerFields(headline: 'Hi'),
    );
    await pumpP7(tester, CampaignFormScreen(initial: input));
    expect(tester.widget<FilledButton>(find.byKey(const Key('campaign-save'))).onPressed, isNull);
    expect(find.text('The end must be after the start'), findsOneWidget);
  });

  testWidgets("a started campaign's form locks kind, title, shops and start, and asks a reason", (tester) async {
    final repo = FakeMarketingRepository();
    final started = detailWith({'kind': 'featured_store', 'slotPosition': 2, 'vendors': [{'id': 'v-1', 'name': 'Spice Hub'}]});
    await pumpP7(tester, CampaignFormScreen(edit: started), marketing: repo);
    expect(tester.widget<TextFormField>(find.byKey(const Key('campaign-title'))).enabled, isFalse);
    expect(find.byKey(const Key('kind-banner')), findsNothing);
    final startField = find.byKey(const Key('campaign-start'));
    await tester.ensureVisible(startField);
    expect(tester.widget<InkWell>(find.descendant(of: startField, matching: find.byType(InkWell)).first).onTap, isNull);
    expect(tester.widget<ChoiceChip>(find.byKey(const Key('slot-3'))).onSelected, isNull);

    await tester.enterText(find.byKey(const Key('campaign-notes')), 'Extended for the weekend');
    await tester.tap(find.byKey(const Key('campaign-save')));
    await settle(tester);
    expect(find.byKey(const Key('reason-field')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('reason-field')), 'Vendor asked by phone');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await settle(tester);
    final edit = repo.edits.single.$2.toJson();
    expect(edit['reason'], 'Vendor asked by phone');
    expect((edit['changes'] as Map).keys, ['notes']);
  });

  testWidgets('consent_required explains that vendor funding needs a request', (tester) async {
    final repo = FakeMarketingRepository()..campaignOutcomes.add(const Refused('consent_required'));
    final input = CampaignInput(
      kind: CampaignKind.banner,
      title: 'Weekend',
      zoneId: 'z-1',
      startsAt: DateTime.now().toUtc().add(const Duration(days: 1)),
      endsAt: DateTime.now().toUtc().add(const Duration(days: 3)),
      fundedBy: Funding.deligro,
      banner: const BannerFields(headline: 'Hi'),
    );
    await pumpP7(tester, CampaignFormScreen(initial: input), marketing: repo);
    await tester.tap(find.byKey(const Key('campaign-save')));
    await settle(tester);
    expect(repo.createdCampaigns, hasLength(1));
    expect(find.text("Vendor-funded campaigns need the vendor's approved request."), findsOneWidget);
  });

  testWidgets('performance shows a dash for no impressions, never NaN, and no comparison when none', (tester) async {
    final repo = FakeMarketingRepository()
      ..campaignBundle = CampaignBundle(
        campaign: detailWith({}),
        performance: CampaignPerformance.fromJson({'impressions': 0, 'clicks': 0, 'ctr': null, 'comparison': null, 'daily': []}),
      );
    await pumpP7(tester, const CampaignDetailScreen(campaignId: 'c-2'), marketing: repo);
    await settle(tester);
    expect(find.byKey(const Key('perf-ctr')), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const Key('perf-ctr'))).data, '—');
    expect(find.textContaining('NaN'), findsNothing);
    expect(find.byKey(const Key('perf-comparison')), findsNothing);
  });

  testWidgets('End now asks a reason and sends end_now', (tester) async {
    final repo = FakeMarketingRepository();
    await pumpP7(tester, const CampaignDetailScreen(campaignId: 'c-2'), marketing: repo);
    await settle(tester);
    await tester.scrollUntilVisible(find.byKey(const Key('campaign-end-now')), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.byKey(const Key('campaign-end-now')));
    await settle(tester);
    await tester.enterText(find.byKey(const Key('reason-field')), 'Budget used up');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await settle(tester);
    expect(repo.actions.single.$2.toJson()['action'], 'end_now');
  });
}
