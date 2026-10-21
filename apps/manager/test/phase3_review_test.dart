// Phase 3 review fixes, app side: list refresh merges by id (#13), every
// advance carries a reason (#14), overrides (#3), the address note (§3.16),
// the new server codes, the accept delay and the emergency copy (#5).
import 'package:deligro_manager/features/orders/order_actions_bar.dart';
import 'package:deligro_manager/features/orders/order_labels.dart';
import 'package:deligro_manager/features/orders/reason_dialog.dart';
import 'package:deligro_manager/models/live.dart';
import 'package:deligro_manager/models/orders.dart';
import 'package:deligro_manager/state/orders.dart';
import 'package:flutter_test/flutter_test.dart';

OrderListItem _item(String id, DateTime createdAt, {String status = 'kitchen'}) => OrderListItem.fromJson({
      'id': id,
      'code': id.toUpperCase(),
      'status': status,
      'createdAt': createdAt.toUtc().toIso8601String(),
      'zoneId': 'z',
      'vendor': {'id': 'v', 'name': 'Spice Hub'},
      'total': 100,
      'itemCount': 1,
      'payment': {'method': 'cod', 'status': 'pending'},
    });

void main() {
  final t0 = DateTime.utc(2026, 10, 21, 12);
  DateTime minus(int m) => t0.subtract(Duration(minutes: m));

  group('refresh merges pages by id (#13)', () {
    // Loaded: two pages of 3, newest first: a b c | d e f.
    final loaded = [for (final (i, id) in ['a', 'b', 'c', 'd', 'e', 'f'].indexed) _item(id, minus(i * 10))];

    test('new orders on top push rows off page one without losing them', () {
      // Two new orders arrive; page one is now n2 n1 a (b and c pushed to page two).
      final page = [_item('n2', t0.add(const Duration(minutes: 2))), _item('n1', t0.add(const Duration(minutes: 1))), loaded[0]];
      final merged = mergeRefreshedPage(loaded, page, pageIsComplete: false);
      expect(merged.map((o) => o.id), ['n2', 'n1', 'a', 'b', 'c', 'd', 'e', 'f']);
    });

    test('a row that left the filter inside page one is dropped, not kept stale', () {
      // b was delivered and left a "pending" list: page one is a c d.
      final page = [loaded[0], loaded[2], loaded[3]];
      final merged = mergeRefreshedPage(loaded, page, pageIsComplete: false);
      expect(merged.map((o) => o.id), ['a', 'c', 'd', 'e', 'f']);
    });

    test('a complete page replaces everything', () {
      final merged = mergeRefreshedPage(loaded, [loaded[0]], pageIsComplete: true);
      expect(merged.map((o) => o.id), ['a']);
    });
  });

  group('actions on the wire', () {
    test('advance carries its reason', () {
      final j = Advance(expected: OrderStatus.placed, reason: 'Vendor confirmed by phone').toJson();
      expect(j['reason'], 'Vendor confirmed by phone');
      expect(j['expected'], 'placed');
    });

    test('the advance quick reasons are the server\'s four', () {
      expect(ReasonPicks.advance, ['Vendor confirmed by phone', 'Rider confirmed by phone', 'Customer confirmed', 'System stuck']);
    });

    test('assign and reassign send override only when overriding', () {
      expect(Assign(riderId: 'r').toJson().containsKey('override'), isFalse);
      final o = Assign(riderId: 'r', override: true, reason: 'On the phone with him').toJson();
      expect(o['override'], isTrue);
      expect(o['reason'], 'On the phone with him');
      expect(Reassign(riderId: 'r', reason: 'Flat tyre', override: true).toJson()['override'], isTrue);
    });

    test('an address-note correction sends kind and note', () {
      final j = Correct(kind: CorrectionKind.addressNote, note: 'Blue gate', reason: 'Customer called').toJson();
      expect(j['kind'], 'address_note');
      expect(j['note'], 'Blue gate');
    });

    test('offline, on a break and no recent location can be overridden; zone and suspension cannot', () {
      expect(canOverride(IneligibleReason.offline), isTrue);
      expect(canOverride(IneligibleReason.onBreak), isTrue);
      expect(canOverride(IneligibleReason.staleFix), isTrue);
      expect(canOverride(IneligibleReason.outOfZone), isFalse);
      expect(canOverride(IneligibleReason.suspended), isFalse);
      expect(canOverride(IneligibleReason.currentRider), isFalse);
    });
  });

  group('reading the server', () {
    test('the drop carries the ops note', () {
      expect(Place.fromJson({'address': '12 Gandhi Nagar', 'note': 'Blue gate'}).note, 'Blue gate');
    });

    test('accept delays and accept_delayed signals parse', () {
      expect(DelayKind.parse('accept'), DelayKind.accept);
      expect(delayText(const Delay(kind: DelayKind.accept, minutes: 3)), 'Not accepted 3 min');
      expect(SignalKind.parse('accept_delayed'), SignalKind.acceptDelayed);
    });

    test('use_advance and refund_exceeds_total read as sentences', () {
      expect(refusalText(const ActionRefused('use_advance')), contains('Mark'));
      expect(refusalText(const ActionRefused('refund_exceeds_total')), contains('refund'));
    });

    test('the emergency option promises what the server does (a push, not a ring)', () {
      expect(escalateEmergencyText, isNot(contains('Ring')));
      expect(escalateEmergencyText, contains('push'));
    });
  });
}
