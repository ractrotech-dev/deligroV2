import 'dart:io';

import 'package:deligro_rider/core/errors.dart';
import 'package:flutter_test/flutter_test.dart';

// The error copy came from the customer app. A rider never sees a basket,
// a refund or a promo code, so none of that copy is left.
void main() {
  test('customer-only codes fall back to the plain message', () {
    for (final code in [
      'coupon_expired',
      'restaurant_closed',
      'empty_cart',
      'invalid_state',
      'already_requested',
      'signature_mismatch',
    ]) {
      expect(friendlyError(code), 'Something went wrong. Please try again.', reason: code);
    }
  });

  test('no shop-front words in the copy or the shared widgets', () {
    final words = RegExp(r"restaurant|basket|refund|promo|coupon|\bcart\b|FSSAI|'ADD'|Sold out", caseSensitive: false);
    for (final path in ['lib/core/errors.dart', 'lib/widgets/common.dart', 'lib/core/format.dart', 'lib/core/geo.dart']) {
      expect(words.hasMatch(File(path).readAsStringSync()), isFalse, reason: path);
    }
  });

  test('rider copy is still there', () {
    expect(friendlyError('not_online'), 'Go online first.');
    expect(friendlyError('phone_taken'), 'That number is already used by another account.');
  });
}
