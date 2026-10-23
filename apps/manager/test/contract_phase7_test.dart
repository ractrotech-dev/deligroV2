import 'dart:convert';
import 'dart:io';

import 'package:deligro_manager/models/customers.dart';
import 'package:deligro_manager/models/marketing.dart';
import 'package:deligro_manager/models/offers.dart';
import 'package:deligro_manager/models/tickets.dart';
import 'package:flutter_test/flutter_test.dart';

/// Phase 7 contract check, app half. `scripts/qa/manager-contract-phase7.ts`
/// runs the marketing, offer and customer readers against a seeded fake
/// PostgREST and writes what each route sends to
/// `fixtures/api/generated/phase7/`. This checks every key a hand fixture in
/// `fixtures/api/phase7/` has is also in the server's answer, with the same
/// JSON type, and then parses the server's answer with the models.
///
///   npm run test:manager-contract   (from the repo root)
///   flutter test test/contract_phase7_test.dart
Map<String, dynamic> _json(String path) => jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
Map<String, dynamic> _gen(String name) => _json('test/fixtures/api/generated/phase7/$name.json');
Map<String, dynamic> _hand(String name) => _json('test/fixtures/api/phase7/$name.json');

String _kind(Object? v) => switch (v) {
      null => 'null',
      bool() => 'bool',
      num() => 'num',
      String() => 'str',
      List() => 'list',
      Map() => 'object',
      _ => v.runtimeType.toString(),
    };

/// Every key in [hand] is in [gen] with the same JSON type. A null on either
/// side matches anything; list elements are each checked against the hand
/// fixture's first element. [optional] lists dotted paths the server may omit.
/// A request's proposed offer is free-form by design, so below it only the
/// JSON kind is compared.
const _opaque = ['.proposedOffer'];

void _sameShape(Object? hand, Object? gen, String path, List<String> errors, Set<String> optional) {
  if (hand == null || gen == null) return;
  if (_kind(hand) != _kind(gen)) {
    errors.add('$path: server sends ${_kind(gen)}, app fixture has ${_kind(hand)}');
    return;
  }
  if (_opaque.any(path.endsWith)) return;
  if (hand is Map && gen is Map) {
    for (final k in hand.keys) {
      final p = '$path.$k';
      if (!gen.containsKey(k)) {
        if (!optional.contains(p)) errors.add('$p: missing from the server answer');
        continue;
      }
      _sameShape(hand[k], gen[k], p, errors, optional);
    }
  } else if (hand is List && gen is List && hand.isNotEmpty) {
    for (var i = 0; i < gen.length; i++) {
      _sameShape(hand.first, gen[i], '$path[]', errors, optional);
    }
  }
}

void _expectSameShape(String name, {Set<String> optional = const {}}) {
  final errors = <String>[];
  _sameShape(_hand(name), _gen(name), name, errors, optional);
  expect(errors, isEmpty, reason: errors.join('\n'));
}

void main() {
  group('server answers carry every field the app fixtures have', () {
    for (final name in [
      'marketing_requests',
      'marketing_request_detail',
      'campaigns_list',
      'campaign_detail',
      'offers_list',
      'offer_detail',
      'customers_list',
      'customer_detail',
      'customer_complaints',
      'customer_feedback',
      'retention',
    ]) {
      test(name, () => _expectSameShape(name));
    }
  });

  group('the models read the server answers without falling back', () {
    test('marketing requests: known types and statuses, counts that add up, a signed attachment', () {
      final page = MarketingRequestPage.fromJson(_gen('marketing_requests'));
      expect(page.items, hasLength(3));
      expect(page.items.map((r) => r.type), isNot(contains(MarketingType.unknown)));
      expect(page.items.map((r) => r.status), isNot(contains(RequestStatus.unknown)));
      expect(page.counts.pending, 2);
      final b = RequestBundle.fromJson(_gen('marketing_request_detail'));
      expect(b.request.attachmentUrl, isNotEmpty);
      expect(b.request.items.map((i) => i.name), ['Paneer Tikka', 'Veg Biryani']);
    });

    test('a request that asked for an offer carries its proposed terms', () {
      final page = MarketingRequestPage.fromJson(_gen('marketing_requests'));
      final asked = page.items.firstWhere((r) => r.type == MarketingType.discountOffer);
      expect(asked.proposedOffer, isNotNull);
      expect(asked.proposedOffer!.toJson(), isNotEmpty);
    });

    test('campaigns: kind, funding, state and performance all read', () {
      final page = CampaignPage.fromJson(_gen('campaigns_list'));
      expect(page.items, hasLength(2));
      expect(page.items.map((c) => c.kind), isNot(contains(CampaignKind.unknown)));
      expect(page.items.map((c) => c.state), isNot(contains(CampaignState.unknown)));
      expect(page.items.any((c) => c.fundedBy == Funding.shared), isTrue);
      final d = CampaignBundle.fromJson(_gen('campaign_detail'));
      expect(d.campaign.title, isNotEmpty);
      expect(d.performance.daily, isNotEmpty);
      expect(d.performance.ctr, greaterThan(0));
      expect(d.performance.comparison, isNotNull);
    });

    test('offers: state, funding, usage by shop (never by customer) and a field-by-field history', () {
      final page = OfferPage.fromJson(_gen('offers_list'));
      expect(page.items, hasLength(2));
      expect(page.items.map((o) => o.state), isNot(contains(OfferState.unknown)));
      final b = OfferBundle.fromJson(_gen('offer_detail'));
      expect(b.usage.byVendor, isNotEmpty);
      expect(b.changes, isNotEmpty);
      expect(b.changes.first.id, isA<String>(), reason: 'change ids stay strings');
      expect(b.changes.any((c) => c.fields.isNotEmpty), isTrue);
      expect(jsonEncode(_gen('offer_detail')), isNot(contains('customerId')));
    });

    test('customers: the phone is masked everywhere and the status is known', () {
      final page = CustomerPage.fromJson(_gen('customers_list'));
      expect(page.items, hasLength(2));
      expect(page.items.map((c) => c.status), isNot(contains(CustomerStatus.unknown)));
      final d = CustomerDetail.fromJson(_gen('customer_detail')['customer'] as Map<String, dynamic>);
      expect(d.phoneMasked, startsWith('••••'));
      expect(d.allowed.revealContact, isTrue);
      expect(d.openComplaints, greaterThan(0));
      final raw = jsonEncode([_gen('customers_list'), _gen('customer_detail')]);
      expect(raw, isNot(contains('9876543210')));
      expect(raw, isNot(contains('9811122233')));
    });

    test('a customer\'s complaints, ratings and feedback read', () {
      final complaints = TicketPage.fromJson(_gen('customer_complaints'));
      expect(complaints.items, isNotEmpty);
      final f = CustomerFeedback.fromJson(_gen('customer_feedback'));
      expect(f.reviews, isNotEmpty);
      expect(f.reviews.any((r) => r.flagged), isTrue);
      expect(f.riderRatings.single.riderCode, 'DR-0007');
    });

    test('retention: the summary and the monthly cohorts read', () {
      final r = Retention.fromJson(_gen('retention'));
      expect(r.summary.repeatRate, greaterThan(0));
      expect(r.cohorts, isNotEmpty);
    });
  });
}
