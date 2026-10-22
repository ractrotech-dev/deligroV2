import 'package:deligro_rider/models/inbox.dart';
import 'package:flutter_test/flutter_test.dart';

// Each switch's hint names everything the server sends under that category
// (src/lib/notifications/order-events.ts), so muting one is an informed choice.
void main() {
  String hint(String key) => notificationCategories.firstWhere((c) => c.key == key).hint;

  test('delivery updates names the handover and the answers to reports', () {
    final h = hint('delivery_updates');
    for (final word in ['instructions', 'delay', 'shop', 'pickup', 'reports', 'manual pickup', 'without the code']) {
      expect(h, contains(word));
    }
  });

  test('document reminders names the verification and change decisions', () {
    final h = hint('documents');
    for (final word in ['expire', 'documents', 'profile changes', 'verification']) {
      expect(h, contains(word));
    }
  });

  test('cash reminders names the deposit decision', () {
    expect(hint('cash'), contains('confirmed or disputed'));
  });
}
