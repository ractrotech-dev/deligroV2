import 'dart:convert';

import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/data/customers_repository.dart';
import 'package:deligro_manager/data/marketing_repository.dart';
import 'package:deligro_manager/data/offers_repository.dart';
import 'package:deligro_manager/models/customers.dart';
import 'package:deligro_manager/models/marketing.dart';
import 'package:deligro_manager/models/offers.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'fixtures/fixtures.dart';

Map<String, dynamic> p7(String name) => apiFixture('phase7/$name');

ApiClient _api(MockClient c) => ApiClient(GoTrueClient(url: 'http://x'), client: c);

void main() {
  group('marketing requests', () {
    test('the list parses, with counts and unknown values kept apart', () {
      final page = MarketingRequestPage.fromJson(p7('marketing_requests'));
      expect(page.items, hasLength(3));
      expect(page.nextCursor, 'cur-2');
      expect(page.counts.pending, 3);
      expect(page.counts.of(RequestStatus.completed), 9);
      final first = page.items.first;
      expect(first.type, MarketingType.featuredStore);
      expect(first.status, RequestStatus.pending);
      expect(first.vendor.name, 'Spice Hub');
      expect(first.preferredStart, '2026-11-01');
      expect(first.budget, 5000);
      expect(page.items[2].type, MarketingType.unknown);
      expect(page.items[2].status, RequestStatus.unknown);
      final offer = page.items[1].proposedOffer!;
      expect(offer.code, 'CAKE50');
      expect(offer.fundedBy, OfferFunding.vendor);
      expect(page.items[1].decidedBy?.name, 'Asha Verma');
      expect(page.items[1].requestedBy.role, 'manager');
    });

    test('the detail carries its campaign', () {
      final b = RequestBundle.fromJson(p7('marketing_request_detail'));
      expect(b.request.items.map((i) => i.name), ['Chicken biryani', 'Veg biryani']);
      expect(b.campaign!.kind, CampaignKind.sponsoredProduct);
      expect(b.campaign!.state, CampaignState.active);
      expect(b.offer, isNull);
    });
  });

  group('campaigns', () {
    test('list and detail parse', () {
      final page = CampaignPage.fromJson(p7('campaigns_list'));
      expect(page.counts.active, 3);
      expect(page.items.first.fundedBy, Funding.shared);
      expect(page.items.first.vendorSharePct, 40);
      expect(page.items.first.slotPosition, 2);
      expect(page.items[2].kind, CampaignKind.unknown);

      final d = CampaignBundle.fromJson(p7('campaign_detail'));
      expect(d.campaign.banner!.ctaLabel, 'Order now');
      expect(d.campaign.allowed.endNow, isTrue);
      expect(d.campaign.allowed.editWindowOnly, isTrue);
      expect(d.performance.comparison, isNull);
      expect(d.performance.daily, hasLength(3));
      expect(d.performance.ctr, 7.0);
    });

    test('CampaignInput sends a slot only for featured stores and a share only when shared', () {
      final banner = CampaignInput(
        kind: CampaignKind.banner,
        title: 'Banner',
        zoneId: 'z-1',
        startsAt: DateTime.utc(2026, 11, 1),
        endsAt: DateTime.utc(2026, 11, 7),
        fundedBy: Funding.deligro,
        slotPosition: 3,
        vendorSharePct: 50,
        banner: const BannerFields(headline: 'Hi', ctaLabel: 'Order'),
      ).toJson();
      expect(banner.containsKey('slotPosition'), isFalse);
      expect(banner.containsKey('vendorSharePct'), isFalse);
      expect((banner['banner'] as Map)['headline'], 'Hi');

      final featured = CampaignInput(
        kind: CampaignKind.featuredStore,
        title: 'Top',
        zoneId: 'z-1',
        vendorIds: const ['v-1'],
        startsAt: DateTime.utc(2026, 11, 1),
        endsAt: DateTime.utc(2026, 11, 7),
        fundedBy: Funding.shared,
        vendorSharePct: 40,
        slotPosition: 2,
        banner: const BannerFields(headline: 'x'),
      ).toJson();
      expect(featured['slotPosition'], 2);
      expect(featured['vendorSharePct'], 40);
      expect(featured['kind'], 'featured_store');
      expect(featured.containsKey('banner'), isFalse);
    });
  });

  group('offers', () {
    test('list and detail parse; change ids stay strings', () {
      final page = OfferPage.fromJson(p7('offers_list'));
      expect(page.items, hasLength(3));
      expect(page.items[1].state, OfferState.expired);
      expect(page.items[1].kind, OfferKind.percent);
      expect(page.counts.exhausted, 1);

      final b = OfferBundle.fromJson(p7('offer_detail'));
      expect(b.offer.allowed.activate, isFalse);
      expect(b.offer.maxPerCustomer, 1);
      expect(b.usage.byVendor, hasLength(2));
      expect(b.usage.discountByFunder.platform, 6000);
      expect(b.changes.first.id, '9007199254740993');
      expect(b.changes.first.fields.single.before, '300');
      expect(b.changes[1].actor, isNull);
      expect(b.changes[1].fields.single.before, isNull);
    });

    test('OfferTerms round-trips', () {
      final t = OfferTerms.fromJson((p7('marketing_requests')['items'] as List)[1]['proposedOffer'] as Map<String, dynamic>);
      final again = OfferTerms.fromJson(t.toJson());
      expect(again.toJson(), t.toJson());
      expect(again.itemIds, ['i-1']);
      expect(again.expiresAt, DateTime.utc(2026, 11, 30, 18, 29, 59));
    });
  });

  group('customers', () {
    test('list, detail, feedback, complaints, refunds and retention parse', () {
      final page = CustomerPage.fromJson(p7('customers_list'));
      expect(page.items, hasLength(3));
      expect(page.items[1].name, isNull);
      expect(page.items[1].status, CustomerStatus.suspended);
      expect(page.items[2].status, CustomerStatus.unknown);

      final d = CustomerDetail.fromJson(p7('customer_detail')['customer'] as Map<String, dynamic>);
      expect(d.allowed.revealContact, isTrue);
      expect(d.allowed.reactivate, isFalse);
      expect(d.localities, ['Station Road, Bemetara']);

      final f = CustomerFeedback.fromJson(p7('customer_feedback'));
      expect(f.reviews.single.vendor.name, 'Spice Hub');
      expect(f.riderRatings.single.riderCode, 'DR-0007');

      final r = Retention.fromJson(p7('retention'));
      expect(r.summary.repeatRate, 38.2);
      expect(r.cohorts[1].r60, isNull);
      expect(r.cohorts[2].r30, isNull);
    });
  });

  group('repositories', () {
    test('a retried decision sends the same clientActionId', () async {
      final ids = <String>[];
      var calls = 0;
      final client = MockClient((req) async {
        ids.add(jsonDecode(req.body)['clientActionId'] as String);
        calls++;
        if (calls == 1) return http.Response(jsonEncode({'error': 'action_failed'}), 500);
        return http.Response(jsonEncode(p7('marketing_request_detail')), 200);
      });
      final repo = ApiMarketingRepository(_api(client));
      final d = RequestDecision.reject(remarks: 'Not this week', expectedStatus: RequestStatus.pending);
      await expectLater(() => repo.decide('r-1', d), throwsA(isA<ApiException>()));
      final out = await repo.decide('r-1', d);
      expect(out, isA<Applied<RequestBundle>>());
      expect(ids, hasLength(2));
      expect(ids[0], ids[1]);
    });

    test('offer refusals keep their code and field', () async {
      final client = MockClient((_) async => http.Response(jsonEncode({'error': 'bad_request', 'field': 'expiresAt'}), 400));
      final repo = ApiOffersRepository(_api(client));
      final out = await repo.create(OfferTerms(code: 'X', kind: OfferKind.flat, value: 10), clientActionId: 'a-1');
      expect(out, isA<Refused<OfferDetail>>());
      expect((out as Refused).field, 'expiresAt');
    });

    test('contact reveal returns the contact and sends the reason', () async {
      final client = MockClient((req) async {
        final body = jsonDecode(req.body) as Map;
        expect(body['reason'], 'refund');
        expect(body['clientActionId'], 'cid');
        return http.Response(jsonEncode({'phone': '+919876543210', 'email': null}), 200);
      });
      final repo = ApiCustomersRepository(_api(client));
      final out = await repo.revealContact('c-1', ContactReason.refund, clientActionId: 'cid');
      expect((out as Applied<ContactReveal>).value!.phone, '+919876543210');
    });
  });
}
