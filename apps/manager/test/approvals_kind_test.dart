import 'package:deligro_manager/models/payment_request.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the kind filter goes to the server, so every page of that kind comes back', () {
    const f = PaymentRequestFilters(status: PaymentStatus.pendingApproval, kind: PaymentKind.vendorSettlement);
    expect(f.toQuery()['kind'], 'vendor_settlement');
    expect(const PaymentRequestFilters().toQuery().containsKey('kind'), isFalse);
    expect(f == const PaymentRequestFilters(status: PaymentStatus.pendingApproval), isFalse);
  });

  test('a reversal of a paid settlement is its own kind', () {
    final k = PaymentKind.parse('settlement_reversal');
    expect(k, PaymentKind.settlementReversal);
    expect(k.label, 'Reverse a paid settlement');
    expect(k.isVendor, isTrue);
  });
}
