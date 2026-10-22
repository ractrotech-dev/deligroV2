import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/features/marketing/marketing_screen.dart';
import 'package:deligro_manager/features/marketing/request_decide_screen.dart';
import 'package:deligro_manager/features/marketing/request_detail_screen.dart';
import 'package:deligro_manager/models/marketing.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_marketing_offers_customers.dart';
import 'p7_helpers.dart';

/// The featured-store request from the list fixture, as a detail bundle.
RequestBundle featuredBundle() =>
    RequestBundle(request: MarketingRequest.fromJson((p7('marketing_requests')['items'] as List).first as Map<String, dynamic>));

void main() {
  testWidgets('the Pending chip shows the server count and Requests opens on pending', (tester) async {
    final repo = FakeMarketingRepository();
    await pumpP7(tester, MarketingScreen(query: Uri.parse('/more/marketing?status=pending')), marketing: repo);
    await settle(tester);
    expect(find.text('Pending (3)'), findsOneWidget);
    expect(repo.requestQueries.first.status, RequestStatus.pending);
    expect(find.text('Diwali top slot'), findsOneWidget);
  });

  testWidgets('reject needs remarks of 3+ characters', (tester) async {
    final repo = FakeMarketingRepository()..requestBundle = featuredBundle();
    await pumpP7(tester, const RequestDetailScreen(requestId: 'r-1'), marketing: repo);
    await settle(tester);
    await tester.ensureVisible(find.byKey(const Key('request-reject')));
    await tester.tap(find.byKey(const Key('request-reject')));
    await settle(tester);
    await tester.enterText(find.byKey(const Key('reason-field')), 'no');
    await tester.pump();
    expect(tester.widget<FilledButton>(find.byKey(const Key('reason-submit'))).onPressed, isNull);
    await tester.enterText(find.byKey(const Key('reason-field')), 'Not this week');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await settle(tester);
    expect(repo.decisions.single.$2.approve, isFalse);
    expect(repo.decisions.single.$2.toJson()['remarks'], 'Not this week');
  });

  testWidgets('approving a featured store without a slot shows the field error and sends nothing', (tester) async {
    final repo = FakeMarketingRepository();
    await pumpP7(tester, RequestDecideScreen(bundle: featuredBundle()), marketing: repo);
    await tester.tap(find.byKey(const Key('decide-approve')));
    await settle(tester);
    expect(find.text('Pick a slot'), findsOneWidget);
    expect(repo.decisions, isEmpty);
  });

  testWidgets('slot_taken says which slot and sends the request pre-filled', (tester) async {
    final repo = FakeMarketingRepository()
      ..decideOutcomes.add(const Refused('slot_taken', [], null, {'error': 'slot_taken', 'slot': 2, 'campaignId': 'c-1'}));
    await pumpP7(tester, RequestDecideScreen(bundle: featuredBundle()), marketing: repo);
    await tester.ensureVisible(find.byKey(const Key('slot-2')));
    await tester.tap(find.byKey(const Key('slot-2')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('decide-approve')));
    await settle(tester);
    final sent = repo.decisions.single.$2.toJson();
    final campaign = sent['campaign'] as Map;
    expect(campaign['slotPosition'], 2);
    expect(campaign['vendorIds'], ['v-1']);
    expect(campaign['fundedBy'], 'vendor');
    expect(campaign['budget'], 5000);
    expect(campaign['requestId'], '11111111-1111-4111-8111-111111111111');
    expect(find.textContaining('Slot 2 is taken by another campaign'), findsOneWidget);
  });

  testWidgets('stale says someone else decided it', (tester) async {
    final repo = FakeMarketingRepository()
      ..requestBundle = featuredBundle()
      ..decideOutcomes.add(const Refused('stale'));
    await pumpP7(tester, const RequestDetailScreen(requestId: 'r-1'), marketing: repo);
    await settle(tester);
    await tester.ensureVisible(find.byKey(const Key('request-reject')));
    await tester.tap(find.byKey(const Key('request-reject')));
    await settle(tester);
    await tester.enterText(find.byKey(const Key('reason-field')), 'Budget too low');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await settle(tester);
    expect(find.text('Someone else decided this request. Showing the latest.'), findsOneWidget);
  });

  testWidgets('a retried approval after a fault resends the same decision id', (tester) async {
    final repo = FakeMarketingRepository()..decideFaults.add(ApiException(0, 'network'));
    await pumpP7(tester, RequestDecideScreen(bundle: featuredBundle()), marketing: repo);
    await tester.ensureVisible(find.byKey(const Key('slot-3')));
    await tester.tap(find.byKey(const Key('slot-3')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('decide-approve')));
    await settle(tester);
    await tester.tap(find.byKey(const Key('decide-approve')));
    await settle(tester);
    expect(repo.decisions, hasLength(2));
    expect(repo.decisions[0].$2.clientActionId, repo.decisions[1].$2.clientActionId);
  });
}
