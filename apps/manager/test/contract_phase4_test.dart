import 'dart:convert';
import 'dart:io';

import 'package:deligro_manager/models/orders.dart' show VendorRef;
import 'package:deligro_manager/models/products.dart';
import 'package:deligro_manager/models/tickets.dart';
import 'package:deligro_manager/models/vendors.dart';
import 'package:flutter_test/flutter_test.dart';

/// Phase 4 contract check, app half. `scripts/qa/manager-contract-emit.ts`
/// writes what the vendor, product and ticket routes send (their own
/// serialisers, in `fixtures/api/generated/`). The app's screens are tested
/// against the hand-written fixtures next to them, so this checks that every
/// key a hand fixture has is also in the server's answer, with the same JSON
/// type, and then parses the server's answer with the models.
///
///   npx tsx scripts/qa/manager-contract-emit.ts   (from the repo root)
///   flutter test test/contract_phase4_test.dart
Map<String, dynamic> _json(String path) => jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
Map<String, dynamic> _gen(String name) => _json('test/fixtures/api/generated/$name.json');
Map<String, dynamic> _hand(String name) => _json('test/fixtures/api/$name.json');

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
/// side matches anything (the field is nullable); list elements are each
/// checked against the hand fixture's first element. [optional] lists dotted
/// paths the server may leave out.
void _sameShape(Object? hand, Object? gen, String path, List<String> errors, Set<String> optional) {
  if (hand == null || gen == null) return;
  if (_kind(hand) != _kind(gen)) {
    errors.add('$path: server sends ${_kind(gen)}, app fixture has ${_kind(hand)}');
    return;
  }
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

void _expectSameShape(String hand, String gen, {Set<String> optional = const {}}) {
  final errors = <String>[];
  _sameShape(_hand(hand), _gen(gen), gen, errors, optional);
  expect(errors, isEmpty, reason: errors.join('\n'));
}

void main() {
  group('server answers carry every field the app fixtures have', () {
    test('vendors list', () => _expectSameShape('vendors_list', 'vendors_list'));
    test('vendor detail', () => _expectSameShape('vendor_detail', 'vendor_detail'));
    test('vendor detail without finance', () {
      _expectSameShape('vendor_detail', 'vendor_detail_no_finance', optional: {'vendor_detail_no_finance.vendor.finance'});
      expect((_gen('vendor_detail_no_finance')['vendor'] as Map).containsKey('finance'), isFalse);
    });
    test('vendor reviews', () => _expectSameShape('vendor_reviews', 'vendor_reviews'));
    test('products list', () => _expectSameShape('products_list', 'products_list'));
    test('product detail', () => _expectSameShape('product_detail', 'product_detail'));
    test('product categories', () => _expectSameShape('product_categories', 'product_categories'));
    test('product insights', () => _expectSameShape('product_insights', 'product_insights'));
    test('ticket thread', () => _expectSameShape('ticket_thread', 'ticket_thread'));
    test('image reviews', () => _expectSameShape('image_reviews', 'image_reviews'));
  });

  group('the models read the server answers without falling back', () {
    test('vendors list', () {
      final p = VendorPage.fromJson(_gen('vendors_list'));
      expect(p.items, hasLength(3));
      expect(p.items.map((v) => v.status), isNot(contains(VendorStatus.unknown)));
      expect(p.items.map((v) => v.openState), isNot(contains(OpenState.unknown)));
      expect(p.counts.all, 3);
    });

    test('vendor detail with and without finance', () {
      final full = VendorDetail.fromJson((_gen('vendor_detail')['vendor'] as Map).cast<String, dynamic>());
      expect(full.finance, isNotNull);
      expect(full.documents.map((d) => d.type), isNot(contains(DocType.unknown)));
      expect(full.documents.map((d) => d.status), isNot(contains(DocStatus.unknown)));
      expect(full.openComplaints, isNotEmpty);
      final bare = VendorDetail.fromJson((_gen('vendor_detail_no_finance')['vendor'] as Map).cast<String, dynamic>());
      expect(bare.finance, isNull);
      expect(bare.summary.status, VendorStatus.suspended);
    });

    test('complaints use the contract roles', () {
      final p = TicketPage.fromJson(_gen('vendor_complaints'));
      expect(p.items, hasLength(2));
      expect(p.items.map((t) => t.requesterRole), isNot(contains(RequesterRole.unknown)));
      expect(p.items.map((t) => t.status), isNot(contains(TicketStatus.unknown)));
    });

    test('directory', () {
      final list = [
        for (final v in (_gen('vendors_directory')['vendors'] as List))
          VendorRef.fromJson((v as Map).cast<String, dynamic>()),
      ];
      expect(list, hasLength(3));
      expect(list.every((v) => v.id.isNotEmpty && v.name.isNotEmpty), isTrue);
    });

    test('a cursor page of products has no counts; the first page counts stand', () {
      expect(ProductPage.fromJson(_gen('products_list_page2')).counts, isNull);
      expect(ProductPage.fromJson(_gen('products_list')).counts, isNotNull);
    });

    test('image reviews', () {
      final p = ImageReviewPage.fromJson(_gen('image_reviews'));
      expect(p.items, hasLength(2));
      expect(p.items.every((i) => i.changeId > 0 && i.imageUrl.isNotEmpty && i.product.id.isNotEmpty), isTrue);
      expect(p.items.first.changedAt.isUtc, isTrue);
      expect(p.items.where((i) => i.previousImageUrl == null), hasLength(1));
      expect(p.nextBefore, 41);
    });

    test('products', () {
      final p = ProductPage.fromJson(_gen('products_list'));
      expect(p.items.map((i) => i.approvalStatus), isNot(contains(ApprovalStatus.unknown)));
      final d = ProductDetail.fromJson((_gen('product_detail')['product'] as Map).cast<String, dynamic>());
      expect(d.item.approvalStatus, ApprovalStatus.pending);
      expect(d.flags.map((f) => f.reason), isNot(contains(FlagReason.unknown)));
      expect(d.changes.map((c) => c.source), isNot(contains(ChangeSource.unknown)));
      expect(d.hoursUnavailable, 31.5);
      expect(parseCategories(_gen('product_categories')).any((c) => c.restricted), isTrue);
      expect(ProductInsights.fromJson(_gen('product_insights')).frequentlyUnavailable, isNotEmpty);
    });

    test('ticket thread', () {
      final t = TicketThread.fromJson(_gen('ticket_thread'));
      expect(t.messages, hasLength(2));
      expect(t.ticket.summary.status, isNot(TicketStatus.unknown));
    });
  });
}
