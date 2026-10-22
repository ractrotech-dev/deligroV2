import 'package:deligro_manager/features/offers/offer_detail_screen.dart';
import 'package:deligro_manager/features/offers/offer_fields.dart';
import 'package:deligro_manager/features/offers/offer_form_screen.dart';
import 'package:deligro_manager/features/offers/offers_screen.dart';
import 'package:deligro_manager/models/offers.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_marketing_offers_customers.dart';
import 'p7_helpers.dart';

void main() {
  test('a percentage over 90 and a missing expiry are refused before sending', () {
    final t = OfferTerms(code: 'BIG95', kind: OfferKind.percent, value: 95);
    final p = offerProblems(t);
    expect(p['value'], 'A percentage must be 1–90');
    expect(p['expiresAt'], 'Every offer needs an expiry');
    expect(offerProblems(OfferTerms(code: 'OK10', kind: OfferKind.percent, value: 10, expiresAt: DateTime.now().add(const Duration(days: 3)))), isEmpty);
  });

  testWidgets('the form blocks 95% and sends nothing', (tester) async {
    final repo = FakeOffersRepository();
    await pumpP7(tester, const OfferFormScreen(), offers: repo);
    await tester.enterText(find.byKey(const Key('offer-code')), 'BIG95');
    await tester.tap(find.text('% off'));
    await tester.pump();
    await tester.enterText(find.byKey(const Key('offer-value-input')), '95');
    await tester.tap(find.byKey(const Key('offer-save')));
    await settle(tester);
    expect(repo.created, isEmpty);
    expect(find.text('A percentage must be 1–90'), findsOneWidget);
  });

  testWidgets('the list shows state counts and platform-wide offers as read-only', (tester) async {
    await pumpP7(tester, const OffersScreen());
    await settle(tester);
    expect(find.text('Active (6)'), findsOneWidget);
    expect(find.text('DIWALI50'), findsOneWidget);
    expect(find.textContaining('Everywhere'), findsOneWidget);
  });

  testWidgets('editing sends expectedUpdatedAt and asks for a reason', (tester) async {
    final repo = FakeOffersRepository();
    await pumpP7(tester, OfferFormScreen(edit: repo.bundle.offer), offers: repo);
    await tester.enterText(find.byKey(const Key('offer-total-input')), '600');
    await tester.tap(find.byKey(const Key('offer-save')));
    await settle(tester);
    await tester.enterText(find.byKey(const Key('reason-field')), 'More demand than planned');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await settle(tester);
    final e = repo.edits.single.$2.toJson();
    expect(e['expectedUpdatedAt'], '2026-10-20T00:00:00.000Z');
    expect(e['changes'], {'maxRedemptions': 600});
    expect(e['reason'], 'More demand than planned');
  });

  testWidgets('activating an expired offer says to set a new expiry first', (tester) async {
    final repo = FakeOffersRepository();
    final j = Map<String, dynamic>.from(p7('offer_detail'));
    j['offer'] = {...(j['offer'] as Map), 'state': 'expired', 'active': false, 'allowed': {'edit': true, 'activate': true, 'deactivate': false}};
    repo.bundle = OfferBundle.fromJson(j);
    repo.outcomes.add(const Refused('expired'));
    await pumpP7(tester, const OfferDetailScreen(code: 'DIWALI50'), offers: repo);
    await settle(tester);
    await tester.scrollUntilVisible(find.byKey(const Key('offer-activate')), 300, scrollable: find.byType(Scrollable).first);
    await tester.tap(find.byKey(const Key('offer-activate')));
    await settle(tester);
    await tester.enterText(find.byKey(const Key('reason-field')), 'Festival extended');
    await tester.pump();
    await tester.tap(find.byKey(const Key('reason-submit')));
    await settle(tester);
    expect(repo.actions.single.$2.activate, isTrue);
    expect(find.text('Set a new expiry first.'), findsOneWidget);
  });

  testWidgets('change history shows field, before → after, who and why', (tester) async {
    await pumpP7(tester, const OfferDetailScreen(code: 'DIWALI50'));
    await settle(tester);
    await tester.scrollUntilVisible(find.byKey(const Key('change-9007199254740993')), 300, scrollable: find.byType(Scrollable).first);
    expect(find.text('Total uses: 300 → 500'), findsOneWidget);
    expect(find.textContaining('Asha Verma'), findsWidgets);
    expect(find.text('Demand is higher than expected'), findsOneWidget);
  });
}
