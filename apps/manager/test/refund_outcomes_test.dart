import 'package:deligro_manager/models/finance.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('a failed refund decision says whether Retry is safe', () {
    test('money sent and its id kept, decision not saved → retry is safe', () {
      final f = refundFailure('effect_failed');
      expect(f.retry, isTrue);
      expect(f.message, contains('Retry'));
    });

    test('money sent but not recorded at all → no retry, contact an admin', () {
      final f = refundFailure('recorded_failed_after_gateway');
      expect(f.retry, isFalse);
      expect(f.message, contains("don't retry"));
      expect(f.message, contains('admin'));
    });

    test('no answer from Razorpay → no retry until an admin checks', () {
      final f = refundFailure('gateway_unknown');
      expect(f.retry, isFalse);
      expect(f.message, contains('Razorpay'));
    });

    test('the gateway refused → nothing moved, retry is safe', () {
      expect(refundFailure('gateway_failed').retry, isTrue);
    });

    test('someone else is deciding it → no retry button', () {
      expect(refundFailure('in_progress').retry, isFalse);
    });
  });
}
