// Wallet points on the Partner app: a fully covered order doesn't read as cash collected.
// Nothing changes for the shop: the total stays the bill and Deligro pays the same.
import 'package:deligro_partner/core/documents.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('invoice wording', () {
    expect(paymentLabel('cod', 'pending'), 'Cash on delivery');
    expect(paymentLabel('cod', 'paid'), 'Paid in full');
    expect(paymentLabel('online', 'paid'), 'Paid online');
  });
}
