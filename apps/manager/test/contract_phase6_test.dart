import 'dart:convert';
import 'dart:io';

import 'package:deligro_manager/models/finance.dart';
import 'package:deligro_manager/models/payment_request.dart';
import 'package:deligro_manager/models/report.dart';
import 'package:deligro_manager/models/settlement.dart';
import 'package:flutter_test/flutter_test.dart';

/// Phase 6 contract check, app half. `scripts/qa/manager-contract-phase6.ts`
/// runs the finance readers and the report registry against a seeded fake
/// PostgREST and writes what each route sends to
/// `fixtures/api/generated/phase6/`. This checks every key a hand fixture in
/// `fixtures/api/phase6/` has is also in the server's answer, with the same
/// JSON type, and then parses the server's answer with the models.
///
///   npm run test:manager-contract   (from the repo root)
///   flutter test test/contract_phase6_test.dart
Map<String, dynamic> _json(String path) => jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
Map<String, dynamic> _gen(String name) => _json('test/fixtures/api/generated/phase6/$name.json');
Map<String, dynamic> _hand(String name) => _json('test/fixtures/api/phase6/$name.json');

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
    for (final name in [
      'finance_overview',
      'vendor_dues',
      'rider_dues',
      'rider_payouts',
      'finance_issues',
      'settlements_list',
      'settlement_detail',
      'refunds',
      'reconciliation_orders',
      'reconciliation_online',
      'reconciliation_cash',
      'payment_requests_settlement',
      'report_kinds',
      'report_kinds_no_finance',
    ]) {
      test(name, () => _expectSameShape(name, name));
    }
    // Report rows are keyed by that report's own columns. The hand fixture adds
    // a text `note` column to exercise text cells; the sales report has none.
    test('report_sales', () => _expectSameShape('report_sales', 'report_sales',
        optional: {'report_sales.rows[].note', 'report_sales.totals.note'}));
  });

  group('the models read the server answers without falling back', () {
    test('finance overview', () {
      final o = FinanceOverview.fromJson(_gen('finance_overview'));
      expect(o.sales.grossSales, greaterThan(0));
      expect(o.series, isNotEmpty);
    });

    test('dues, payouts, issues', () {
      expect(VendorDuesPage.fromJson(_gen('vendor_dues')).items, hasLength(1));
      expect(RiderDuesPage.fromJson(_gen('rider_dues')).items, hasLength(1));
      expect(RiderPayoutPage.fromJson(_gen('rider_payouts')).items, hasLength(1));
      final issues = FinanceIssuePage.fromJson(_gen('finance_issues'));
      expect(issues.items, isNotEmpty);
      expect(issues.items.map((i) => i.type), isNot(contains(FinanceIssueType.unknown)));
    });

    test('settlements and the request behind one', () {
      final page = SettlementPage.fromJson(_gen('settlements_list'));
      expect(page.items.map((s) => s.status), isNot(contains(SettlementStatus.unknown)));
      final d = SettlementDetail.fromJson(_gen('settlement_detail'));
      expect(d.lines, hasLength(1));
      expect(d.corrections.map((c) => c.status), isNot(contains(CorrectionStatus.unknown)));
      expect(d.request?.settlementId, isNotNull);
      expect(d.request?.selfApproved, isFalse);
    });

    test('refunds', () {
      final r = RefundPage.fromJson(_gen('refunds'));
      expect(r.items.single.status, isNot(RefundStatus.unknown));
    });

    test('reconciliation, all three sections', () {
      expect(Reconciliation.fromJson(_gen('reconciliation_orders')).orderItems, hasLength(1));
      expect(Reconciliation.fromJson(_gen('reconciliation_online')).onlineItems, isNotEmpty);
      final cash = Reconciliation.fromJson(_gen('reconciliation_cash'));
      expect(cash.cashItems, hasLength(1));
      expect(cash.managers, hasLength(1));
    });

    test('vendor settlement requests', () {
      final p = PaymentRequestPage.fromJson(_gen('payment_requests_settlement'));
      expect(p.items.single.kind, PaymentKind.vendorSettlement);
      expect(p.items.single.canDecide, isTrue);
    });

    test('report kinds: finance kinds only with finance access', () {
      final all = ReportKindList.fromJson(_gen('report_kinds')).kinds.map((k) => k.kind).toSet();
      final some = ReportKindList.fromJson(_gen('report_kinds_no_finance')).kinds.map((k) => k.kind).toSet();
      expect(all.length, greaterThan(some.length));
      expect(some, isNot(contains('commission')));
    });

    test('a report: columns typed, rows read, generated by the server', () {
      final r = ReportPayload.fromJson(_gen('report_sales'));
      expect(r.columns.map((c) => c.type), isNot(contains(ReportColumnType.unknown)));
      expect(r.rows, isNotEmpty);
      expect(_gen('report_sales')['generatedAt'], isA<String>());
      final noFin = ReportPayload.fromJson(_gen('report_sales_no_finance'));
      expect(noFin.columns.length, lessThanOrEqualTo(r.columns.length));
    });

    test('the vendor settlement report: rows, per-status note, waiting-for-approval highlight', () {
      final r = ReportPayload.fromJson(_gen('report_vendor_settlement'));
      expect(r.rows, hasLength(1));
      expect(r.rows.first['status'], 'waiting for approval');
      expect(r.highlights.map((h) => h.key), contains('waiting'));
      expect(r.notes.join(' '), contains('Void settlements are left out'));
    });
  });
}
