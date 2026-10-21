// Phase 5 I1: the app reads the shapes Part S actually ships.
import 'package:deligro_manager/features/riders/rider_tabs.dart';
import 'package:deligro_manager/models/cash.dart';
import 'package:deligro_manager/models/live.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes/fake_rider_repositories.dart';
import 'rider_helpers.dart';

void main() {
  test('disputes page carries the server counts', () {
    final p = CashDisputePage.fromJson({
      'items': <Object>[],
      'nextCursor': null,
      'counts': {'open': 4, 'resolved': 2},
    });
    expect(p.counts?.open, 4);
    expect(p.counts?.resolved, 2);
  });

  test('disputes page without counts leaves them null', () {
    final p = CashDisputePage.fromJson({
      'items': <Object>[],
      'nextCursor': null,
    });
    expect(p.counts, isNull);
  });

  test('a live rider without `code` falls back to `riderCode`', () {
    final r = LiveRider.fromJson({
      'id': 'r-1',
      'name': 'Ravi',
      'riderCode': 'DR-0007',
      'state': 'available',
    });
    expect(r.code, 'DR-0007');
  });

  test('`code` wins over `riderCode` when both are sent', () {
    final r = LiveRider.fromJson({
      'id': 'r-1',
      'name': 'Ravi',
      'code': 'DR-0001',
      'riderCode': 'DR-0007',
      'state': 'available',
    });
    expect(r.code, 'DR-0001');
  });

  testWidgets('the active route is drawn dashed and labelled approximate', (
    tester,
  ) async {
    await pumpRider(tester, Scaffold(body: RiderMap(rider: fixtureRider())));
    final layer = tester.widget<PolylineLayer>(find.byType(PolylineLayer));
    expect(layer.polylines, isNotEmpty);
    expect(layer.polylines.first.pattern, isNot(const StrokePattern.solid()));
    expect(find.byKey(const Key('rider-route-approx')), findsOneWidget);
    expect(find.text('Route: straight line, approx.'), findsOneWidget);
  });
}
