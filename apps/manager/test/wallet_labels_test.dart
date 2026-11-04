// The customer wallet in the Manager app: read-only, and a points order isn't called cash.
import 'package:deligro_manager/features/orders/order_labels.dart';
import 'package:deligro_manager/models/customers.dart';
import 'package:deligro_manager/models/orders.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the payment label says points when points are on the order', () {
    expect(
      paymentLabel(Payment.fromJson({'method': 'cod', 'status': 'pending'})),
      'Cash · pending',
    );
    expect(
      paymentLabel(Payment.fromJson({'method': 'cod', 'status': 'pending', 'pointsUsed': 50})),
      'Cash and points · pending',
    );
    expect(
      paymentLabel(Payment.fromJson({'method': 'cod', 'status': 'paid', 'pointsUsed': 150})),
      'Points · paid',
    );
    expect(
      paymentLabel(Payment.fromJson({'method': 'online', 'status': 'paid'})),
      'Online · paid',
    );
  });

  test('the money reads the points, and an older server means none', () {
    expect(OrderMoney.fromJson({'total': 200, 'pointsUsed': 50}).pointsUsed, 50);
    expect(OrderMoney.fromJson({'total': 200}).pointsUsed, 0);
  });

  test('a customer detail reads the wallet balance, and an older server means none', () {
    Map<String, dynamic> base() => {'id': 'c1', 'shortId': 'C1', 'name': 'Asha', 'status': 'active'};
    expect(CustomerDetail.fromJson({...base(), 'walletBalance': 75}).walletBalance, 75);
    expect(CustomerDetail.fromJson(base()).walletBalance, 0);
  });
}
