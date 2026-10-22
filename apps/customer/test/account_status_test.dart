// Phase 7 (0162): a restricted or suspended customer is told why, in plain
// words — the server's sentence when it sends one, never a generic error.
import 'package:deligro_customer/core/api.dart';
import 'package:deligro_customer/core/errors.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a refused order shows the server\'s own sentence', () {
    final e = ApiException(403, 'account_restricted',
        message: 'Your account can\'t place orders right now. Contact Deligro support for help.');
    expect(e.friendly, 'Your account can\'t place orders right now. Contact Deligro support for help.');
  });

  test('without a server sentence the code still reads plainly', () {
    expect(ApiException(403, 'account_restricted').friendly, contains('can\'t place orders'));
    expect(friendlyError('account_suspended'), 'This account has been suspended. Contact Deligro support for help.');
  });

  test('new coupon refusals have their own words', () {
    expect(couponError('wrong_zone'), 'This code doesn\'t work in your area.');
    expect(couponError('no_eligible_items'), contains('other dishes'));
    expect(couponError('not_started'), contains('hasn\'t started'));
  });
}
