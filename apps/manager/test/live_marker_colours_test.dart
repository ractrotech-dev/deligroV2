import 'package:deligro_manager/features/live/live_map.dart';
import 'package:deligro_manager/features/orders/order_labels.dart';
import 'package:deligro_manager/models/live.dart';
import 'package:deligro_manager/models/orders.dart';
import 'package:deligro_manager/theme/app_theme.dart';
import 'package:flutter_test/flutter_test.dart';

/// Rider markers and order pins share one map, so a rider state must never
/// borrow an order-status colour — "on a break" used to be the same blue as a
/// Ready or On-the-way pin.
void main() {
  for (final (name, c) in [('light', AppColors.light), ('dark', AppColors.dark)]) {
    test('$name: every live rider colour differs from every order pin colour', () {
      // Only active orders are pinned on Live.
      final pins = {
        for (final s in [OrderStatus.placed, OrderStatus.kitchen, OrderStatus.ready, OrderStatus.onTheWay])
          statusColor(c, s),
      };
      for (final state in [RiderState.available, RiderState.onDelivery, RiderState.onBreak]) {
        final rider = LiveRider(id: 'r', name: 'R', state: state);
        expect(pins.contains(riderColor(c, rider)), isFalse, reason: '$state shares a pin colour');
      }
    });

    test('$name: rider states are distinguishable from each other', () {
      final colours = {
        for (final state in [RiderState.available, RiderState.onDelivery, RiderState.onBreak])
          riderColor(c, LiveRider(id: 'r', name: 'R', state: state)),
      };
      expect(colours.length, 3);
    });
  }
}
