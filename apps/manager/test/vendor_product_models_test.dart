import 'dart:convert';

import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/data/vendors_repository.dart';
import 'package:deligro_manager/models/outcome.dart';
import 'package:deligro_manager/models/products.dart';
import 'package:deligro_manager/models/tickets.dart';
import 'package:deligro_manager/models/vendors.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'fixtures/fixtures.dart';

void main() {
  group('fixtures parse', () {
    test('vendors list', () {
      final p = VendorPage.fromJson(apiFixture('vendors_list'));
      expect(p.items, hasLength(4));
      expect(p.nextCursor, 'c-2');
      expect(p.counts.pending, 3);
      expect(p.counts.online, 31);
      expect(p.items[3].status, VendorStatus.rejected);
      expect(p.items[2].openState, OpenState.temporarilyClosed);
    });

    test('vendor detail with and without finance', () {
      final j = Map<String, dynamic>.from(apiFixture('vendor_detail')['vendor'] as Map);
      final withFinance = VendorDetail.fromJson(j);
      expect(withFinance.finance, isNotNull);
      expect(withFinance.finance!.settlements, hasLength(2));
      expect(withFinance.documents.map((d) => d.status), [DocStatus.verified, DocStatus.pending, DocStatus.rejected]);
      expect(withFinance.performance.ratingDistribution[5], 65);
      expect(withFinance.address.pinned, isTrue);
      expect(withFinance.allowed.suspend, isTrue);
      expect(withFinance.openComplaints.single.status, TicketStatus.open);

      final noFinance = VendorDetail.fromJson(Map<String, dynamic>.from(j)..remove('finance'));
      expect(noFinance.finance, isNull);
    });

    test('unknown statuses read as unknown', () {
      final v = VendorListItem.fromJson({'id': 'x', 'status': 'archived', 'openState': 'sleeping'});
      expect(v.status, VendorStatus.unknown);
      expect(v.openState, OpenState.unknown);
      expect(TicketStatus.parse('weird'), TicketStatus.unknown);
      expect(ApprovalStatus.parse(null), ApprovalStatus.unknown);
    });

    test('reviews, ticket thread, products, categories, insights', () {
      final r = ReviewPage.fromJson(apiFixture('vendor_reviews'));
      expect(r.items.first.subRatings.given, [('Food', 5), ('Delivery', 4)]);
      expect(r.items.first.replyText, 'Thank you!');

      final t = TicketThread.fromJson(apiFixture('ticket_thread'));
      expect(t.messages.map((m) => m.id), ['msg-1', 'msg-2', 'msg-3'], reason: 'oldest first');
      expect(t.messages[1].internal, isTrue);
      expect(t.ticket.restaurant!.name, 'Spice Hub');
      expect(t.ticket.summary.status, TicketStatus.inProgress);

      final p = ProductPage.fromJson(apiFixture('products_list'));
      expect(p.items.first.pendingPrice, 220);
      expect(p.items[1].stockTracked, isFalse);
      expect(p.items[1].stockWords, 'Not tracked');
      expect(p.items[2].stockWords, 'Sold out');
      expect(p.items[3].lowStock, isTrue);
      expect(p.counts.outOfStock, 4);

      final d = ProductDetail.fromJson(apiFixture('product_detail')['product'] as Map<String, dynamic>);
      expect(d.changes.map((c) => c.id), [813, 812, 811], reason: 'newest first');
      expect(d.changes[1].summary, 'Price ₹160 → ₹180');
      expect(d.changes[0].summary, 'Stock Not tracked → 12');
      expect(d.hoursUnavailable, 6.5);
      expect(d.allowed.adjustStock, isFalse);

      expect(parseCategories(apiFixture('product_categories'))[1].restricted, isTrue);
      final i = ProductInsights.fromJson(apiFixture('product_insights'));
      expect(i.frequentlyUnavailable.single.hoursUnavailable, 31.5);
      expect(i.priceChanges.single.changePct, 12.5);
    });
  });

  group('Part S contract notes', () {
    test("detail's openComplaints is the array; the header count follows it", () {
      final v = VendorDetail.fromJson(apiFixture('vendor_detail')['vendor'] as Map<String, dynamic>);
      expect(v.openComplaints, hasLength(1));
      expect(v.summary.openComplaints, 1);
    });

    test('requester roles read as vendor / rider / customer', () {
      expect(RequesterRole.parse('restaurant').label, 'Vendor');
      expect(RequesterRole.parse('driver').label, 'Rider');
      expect(RequesterRole.parse('customer').label, 'Customer');
    });

    test('success with a failed re-read comes back as Applied(null)', () async {
      final client = MockClient((_) async => http.Response(jsonEncode({'ok': true, 'vendor': null}), 200));
      final repo = ApiVendorsRepository(ApiClient(GoTrueClient(url: 'http://x'), client: client));
      final out = await repo.act('v-1', SuspendVendor(expected: VendorStatus.active, reason: 'Hygiene'));
      expect(out, isA<Applied<VendorDetail>>());
      expect((out as Applied<VendorDetail>).value, isNull);
    });
  });

  group('filters', () {
    test('vendor filters read the dashboard link and round-trip', () {
      final f = VendorFilters.fromUri(Uri.parse('/more/vendors?filter=online'));
      expect(f.filter, VendorQuickFilter.online);
      expect(VendorFilters.fromUri(Uri(queryParameters: f.toQuery())), f);

      final g = VendorFilters.fromUri(Uri.parse('/more/vendors?status=suspended,pending&q=spi&zone=z-1'));
      expect(g.statuses, {VendorStatus.suspended, VendorStatus.pending});
      expect(g.toQuery(), {'q': 'spi', 'status': 'pending,suspended', 'zone': 'z-1'});
      expect(VendorFilters.fromUri(Uri(queryParameters: g.toQuery())), g);
    });

    test('product filters map quick tabs to the contract', () {
      expect(const ProductFilters(quick: ProductQuick.outOfStock).toQuery(), {'availability': 'out_of_stock'});
      expect(const ProductFilters(quick: ProductQuick.pendingApproval).toQuery(), {'approval': 'pending'});
      expect(const ProductFilters(quick: ProductQuick.flagged).toQuery(), {'flagged': 'open'});
      expect(const ProductFilters(quick: ProductQuick.hidden).toQuery(), {'hidden': 'true'});
      final f = ProductFilters.fromUri(Uri.parse('/more/products?availability=low_stock&vendor=v-1'));
      expect(f.quick, ProductQuick.lowStock);
      expect(f.vendorId, 'v-1');
    });
  });

  group('actions', () {
    test('an approval keeps its id on retry and on "approve anyway"', () {
      final a = ApproveVendor(expected: VendorStatus.pending, reason: 'Documents verified');
      final again = a.anyway();
      expect(again.clientActionId, a.clientActionId);
      expect(again.toJson()['override'], isTrue);
      expect(a.toJson(), containsPair('expected', 'pending'));
      expect(a.toJson()['action'], 'approve');
    });

    test('stock adjustment sends null to stop tracking', () {
      expect(AdjustStock(stockQty: null, reason: 'Vendor asked').toJson(), containsPair('stockQty', null));
      expect(AdjustStock(stockQty: 25, reason: 'Recount').toJson()['stockQty'], 25);
    });

    test('ApiVendorsRepository maps 409 documents_unverified to Refused with the missing types', () async {
      final client = MockClient((req) async {
        expect(req.url.path, '/api/manager/vendors/v-1/actions');
        expect(jsonDecode(req.body)['clientActionId'], isNotEmpty);
        return http.Response(jsonEncode({'error': 'documents_unverified', 'missing': ['fssai']}), 409);
      });
      final repo = ApiVendorsRepository(ApiClient(GoTrueClient(url: 'http://x'), client: client));
      final out = await repo.act('v-1', ApproveVendor(expected: VendorStatus.pending, reason: 'ok ok'));
      expect(out, isA<Refused<VendorDetail>>());
      final r = out as Refused<VendorDetail>;
      expect(r.code, 'documents_unverified');
      expect(r.reasons, ['fssai']);
    });

    test('a server fault is thrown, not refused', () async {
      final client = MockClient((_) async => http.Response(jsonEncode({'error': 'action_failed'}), 500));
      final repo = ApiVendorsRepository(ApiClient(GoTrueClient(url: 'http://x'), client: client));
      expect(
        () => repo.act('v-1', SuspendVendor(expected: VendorStatus.active, reason: 'Hygiene')),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'action_failed')),
      );
    });
  });

  group('onboard draft', () {
    test('validates the mobile and saves without the password', () {
      const d = OnboardDraft(ownerName: 'Anil', mobile: '981234567', email: 'a@b.in');
      expect(d.mobileError, 'Enter a 10-digit mobile number');
      expect(d.copyWith(mobile: '9812345678').ownerError, isNull);
      final saved = d.copyWith(password: 'secret123').toSaved();
      expect(saved['password'], isNull);
      expect(OnboardDraft.fromJson(saved).mobile, '981234567');
    });
  });
}
