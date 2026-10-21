import 'dart:convert';

import 'package:deligro_manager/core/api.dart';
import 'package:deligro_manager/data/orders_repository.dart';
import 'package:deligro_manager/models/live.dart';
import 'package:deligro_manager/models/orders.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'fixtures/fixtures.dart';

class _MockAuth extends Mock implements GoTrueClient {}

ApiClient _api(Future<http.Response> Function(http.Request) handler) {
  final auth = _MockAuth();
  when(() => auth.currentSession).thenReturn(null);
  return ApiClient(auth, client: MockClient(handler));
}

void main() {
  group('contract fixtures parse', () {
    test('order list', () {
      final page = OrderPage.fromJson(apiFixture('orders_list'));
      expect(page.items, hasLength(11));
      expect(page.nextCursor, isNotNull);
      expect(page.counts.delayed, 2);
      expect(page.counts.unassigned, 1);
      final first = page.items.first;
      expect(first.code, 'AB12CD34');
      expect(first.status, OrderStatus.kitchen);
      expect(first.vendor.name, 'Spice Hub');
      expect(first.payment.method, PaymentMethod.cod);
      expect(first.payment.status, PaymentStatus.pending);
      expect(first.delay!.kind, DelayKind.prep);
      expect(first.delay!.minutes, 12);
      expect(first.eta!.dueAt, DateTime.parse('2026-10-21T08:50:00.000Z'));
      expect(page.items[1].rider!.code, 'DR-0004');
      expect(page.items[1].byPhone, isTrue);
      expect(page.items[1].deliveryStatus, DeliveryStatus.pickedUp);
      expect(page.items[1].eta!.late, isTrue);
      expect(page.items[5].cancellation!.by, CancelledBy.vendor);
      expect(page.items[5].cancellation!.reason, 'Out of stock');
    });

    test('order detail', () {
      final d = OrderDetail.fromJson(apiFixture('order_detail')['order'] as Map<String, dynamic>);
      expect(d.summary.code, 'CD34EF56');
      expect(d.items, hasLength(2));
      expect(d.items.first.lineTotal, 360);
      expect(d.money.total, 420);
      expect(d.money.deliveryFee, 40);
      expect(d.pickup.address, 'Station Road, Bemetara');
      expect(d.drop.landmark, 'Near the water tank');
      expect(d.delivery!.lastFix!.ageSeconds, 540);
      expect(d.delivery!.rider!.phone, isNull);
      expect(d.timeline, hasLength(6));
      expect(d.timeline.last.actor, isNull);
      expect(d.timeline[4].actor!.role, ActorRole.manager);
      expect(d.timeline[3].method, 'code');
      expect(d.tickets.single.number, 17);
      expect(d.allowed.advance, OrderStatus.delivered);
      expect(d.allowed.assign, isFalse);
      expect(d.allowed.reassign, isTrue);
    });

    test('rider candidates — every ineligible reason', () {
      final riders = parseRiderCandidates(apiFixture('order_riders'));
      expect(riders, hasLength(8));
      expect(riders.first.eligible, isTrue);
      expect(riders.first.distanceKm, 1.2);
      expect(riders[2].distanceKm, isNull);
      expect(
        riders.where((r) => !r.eligible).map((r) => r.ineligibleReason).toSet(),
        {
          IneligibleReason.staleFix,
          IneligibleReason.onBreak,
          IneligibleReason.offline,
          IneligibleReason.suspended,
          IneligibleReason.outOfZone,
          IneligibleReason.currentRider,
        },
      );
    });

    test('live snapshot', () {
      final s = LiveSnapshot.fromJson(apiFixture('live'));
      expect(s.riders, hasLength(4));
      expect(s.riders.first.stale, isTrue);
      expect(s.riders.first.state, RiderState.stale);
      expect(s.riders[2].state, RiderState.onDelivery);
      expect(s.riders[3].state, RiderState.onBreak);
      expect(s.orders, hasLength(3));
      expect(s.orders.first.pickupPoint!.lat, 21.7151);
      expect(s.orders.first.item.code, 'AB12CD34');
      expect(s.lanes['on_the_way'], 4);
      expect(s.unassigned, ['ab12cd34-0000-4000-8000-000000000001']);
      expect(s.delayed.first.kind, DelayKind.delivery);
      expect(s.signals.first.kind, SignalKind.riderInactive);
      expect(s.signals.last.kind, SignalKind.unknown);
      expect(s.thresholds.staleSeconds, 120);
    });
  });

  test('nulls parse: no rider, no eta, no delay', () {
    final items = OrderPage.fromJson(apiFixture('orders_list')).items;
    final placed = items[3];
    expect(placed.rider, isNull);
    expect(placed.eta, isNull);
    expect(placed.deliveryStatus, isNull);
    final delivered = items[4];
    expect(delivered.delay, isNull);
    expect(delivered.eta, isNull);
    expect(delivered.cancellation, isNull);
    expect(items[2].payment.method, isNull);
    expect(items[2].payment.status, isNull);
  });

  test('customer without a phone key has phone == null', () {
    final d = OrderDetail.fromJson(apiFixture('order_detail')['order'] as Map<String, dynamic>);
    expect(d.customer.name, 'Asha');
    expect(d.customer.phone, isNull);
  });

  test('unknown enum strings become .unknown, never a throw', () {
    final odd = OrderPage.fromJson(apiFixture('orders_list')).items[6];
    expect(odd.status, OrderStatus.unknown);
    expect(odd.payment.method, PaymentMethod.unknown);
    expect(odd.payment.status, PaymentStatus.unknown);
    expect(odd.deliveryStatus, DeliveryStatus.unknown);
    expect(odd.delay!.kind, DelayKind.unknown);
    expect(odd.cancellation!.by, isNull);
  });

  group('OrderFilters', () {
    // 01:30 IST on 22 Oct: "today" is the 22nd in India, the 21st in UTC.
    final now = DateTime.utc(2026, 10, 21, 20, 0);

    test('status=today is the IST calendar day', () {
      final f = OrderFilters.fromUri(Uri.parse('/orders?status=today'), now: now);
      expect(f.from, DateTime.utc(2026, 10, 21, 18, 30));
      expect(f.to, DateTime.utc(2026, 10, 22, 18, 30));
      expect(f.statuses, isEmpty);
    });

    test('status=pending is the four active statuses', () {
      final f = OrderFilters.fromUri(Uri.parse('/orders?status=pending'), now: now);
      expect(f.statuses, {'placed', 'kitchen', 'ready', 'on_the_way'});
    });

    test('status=completed is delivered; status=cancelled opens the Cancelled queue', () {
      expect(OrderFilters.fromUri(Uri.parse('/orders?status=completed')).statuses, {'delivered'});
      final c = OrderFilters.fromUri(Uri.parse('/orders?status=cancelled'));
      expect(c.queue, OrderQueue.cancelled);
      expect(c.statuses, isEmpty);
    });

    test('queue and the other parameters are read', () {
      final f = OrderFilters.fromUri(Uri.parse('/orders?queue=delayed&vendor=v1&rider=r1&payment=cod,paid&zone=z1&q=ab12'));
      expect(f.queue, OrderQueue.delayed);
      expect(f.vendorId, 'v1');
      expect(f.riderId, 'r1');
      expect(f.payments, {'cod', 'paid'});
      expect(f.zoneId, 'z1');
      expect(f.q, 'ab12');
    });

    test('toQuery round-trips through fromUri', () {
      final f = OrderFilters(
        q: 'cd34',
        from: DateTime.utc(2026, 10, 20, 18, 30),
        to: DateTime.utc(2026, 10, 21, 18, 30),
        vendorId: 'v1',
        riderId: 'r1',
        statuses: const {'kitchen', 'ready'},
        payments: const {'online', 'failed'},
        zoneId: 'z1',
        queue: OrderQueue.unassigned,
      );
      final back = OrderFilters.fromUri(Uri(path: '/orders', queryParameters: f.toQuery()));
      expect(back, f);
      expect(OrderFilters.fromUri(Uri(path: '/orders', queryParameters: const OrderFilters().toQuery())),
          const OrderFilters());
    });

    test('toQuery sends ISO UTC instants and comma lists', () {
      final q = OrderFilters(
        from: DateTime.utc(2026, 10, 20, 18, 30),
        statuses: const {'ready', 'kitchen'},
      ).toQuery();
      expect(q['from'], '2026-10-20T18:30:00.000Z');
      expect(q['status']!.split(',').toSet(), {'ready', 'kitchen'});
      expect(q.containsKey('to'), isFalse);
    });
  });

  group('actions', () {
    test('an action keeps one clientActionId however often it is sent', () {
      final a = Advance(expected: OrderStatus.kitchen);
      final first = a.toJson()['clientActionId'];
      expect(first, matches(RegExp(r'^[0-9a-f-]{36}$')));
      expect(a.toJson()['clientActionId'], first);
      expect(Advance(expected: OrderStatus.kitchen).clientActionId, isNot(first));
    });

    test('each action sends the pinned body', () {
      expect(Advance(expected: OrderStatus.onTheWay, reason: 'Confirmed by phone').toJson(), {
        'action': 'advance',
        'expected': 'on_the_way',
        'reason': 'Confirmed by phone',
        'clientActionId': isA<String>(),
      });
      expect(Reassign(riderId: 'r9', afterPickup: true, reason: 'Rider vehicle issue').toJson(),
          containsPair('afterPickup', true));
      expect(Assign(riderId: 'r9').toJson(), allOf(containsPair('action', 'assign'), containsPair('riderId', 'r9'),
          containsPair('afterPickup', false)));
      expect(Escalate(priority: TicketPriority.emergency, reason: 'Safety concern').toJson(),
          containsPair('priority', 'emergency'));
      expect(
        Correct(kind: CorrectionKind.itemUnavailable, itemId: 'i1', reason: 'Rider/vendor mistake').toJson(),
        allOf(containsPair('kind', 'item_unavailable'), containsPair('itemId', 'i1')),
      );
      expect(Correct(kind: CorrectionKind.status, toStatus: 'ready', reason: 'Wrong status tapped').toJson(),
          allOf(containsPair('kind', 'status'), containsPair('toStatus', 'ready')));
      final note = Note(text: 'Gate locked').toJson();
      expect(note['note'], 'Gate locked');
      expect(note.containsKey('reason'), isFalse);
      expect(Cancel(reason: 'Shop closed').toJson(), containsPair('action', 'cancel'));
    });

    test('a retried action sends the same clientActionId to the server', () async {
      final sent = <String>[];
      final repo = ApiOrdersRepository(_api((req) async {
        sent.add((jsonDecode(req.body) as Map)['clientActionId'] as String);
        return http.Response(jsonEncode({'ok': true, 'order': apiFixture('order_detail')['order']}), 200);
      }));
      final a = Advance(expected: OrderStatus.onTheWay);
      await repo.act('o1', a);
      await repo.act('o1', a);
      expect(sent, hasLength(2));
      expect(sent[0], sent[1]);
    });

    test('409 rider_ineligible becomes ActionRefused with its reasons', () async {
      Uri? hit;
      final repo = ApiOrdersRepository(_api((req) async {
        hit = req.url;
        return http.Response('{"error":"rider_ineligible","reasons":["stale_fix"]}', 409);
      }));
      final out = await repo.act('o1', Reassign(riderId: 'r1', reason: 'Rider not responding'));
      expect(hit!.path, '/api/manager/orders/o1/actions');
      expect(out, isA<ActionRefused>());
      expect((out as ActionRefused).code, 'rider_ineligible');
      expect(out.reasons, ['stale_fix']);
    });

    test('a 200 becomes ActionDone with the order (and the ticket for escalate)', () async {
      final repo = ApiOrdersRepository(_api((req) async => http.Response(
            jsonEncode({
              'ok': true,
              'order': apiFixture('order_detail')['order'],
              'ticket': {'id': 't1', 'number': 18},
            }),
            200,
          )));
      final out = await repo.act('o1', Escalate(reason: 'Customer complaint'));
      expect(out, isA<ActionDone>());
      expect((out as ActionDone).order.summary.code, 'CD34EF56');
      expect(out.ticket!.number, 18);
    });

    test('a network failure is thrown, not turned into a refusal', () async {
      final repo = ApiOrdersRepository(_api((_) async => throw Exception('offline')));
      expect(() => repo.act('o1', Cancel(reason: 'Shop closed')),
          throwsA(isA<ApiException>().having((e) => e.code, 'code', 'network')));
    });
  });

  group('repositories read the pinned routes', () {
    test('list sends filters, cursor and limit; detail unwraps order; riders unwraps riders', () async {
      final seen = <Uri>[];
      final repo = ApiOrdersRepository(_api((req) async {
        seen.add(req.url);
        if (req.url.path.endsWith('/riders')) return http.Response(jsonEncode(apiFixture('order_riders')), 200);
        if (req.url.path == '/api/manager/orders') return http.Response(jsonEncode(apiFixture('orders_list')), 200);
        return http.Response(jsonEncode(apiFixture('order_detail')), 200);
      }));
      final page = await repo.list(const OrderFilters(queue: OrderQueue.delayed, q: 'ab12'), cursor: 'c1');
      expect(page.items, isNotEmpty);
      expect(seen.last.queryParameters, containsPair('queue', 'delayed'));
      expect(seen.last.queryParameters, containsPair('q', 'ab12'));
      expect(seen.last.queryParameters, containsPair('cursor', 'c1'));
      expect(seen.last.queryParameters, containsPair('limit', '50'));
      expect((await repo.detail('o1')).summary.code, 'CD34EF56');
      expect(seen.last.path, '/api/manager/orders/o1');
      expect(await repo.riders('o1'), hasLength(8));
      expect(seen.last.path, '/api/manager/orders/o1/riders');
    });

    test('live passes the zone', () async {
      Uri? hit;
      final repo = ApiLiveRepository(_api((req) async {
        hit = req.url;
        return http.Response(jsonEncode(apiFixture('live')), 200);
      }));
      final s = await repo.snapshot(zoneId: 'z1');
      expect(hit!.path, '/api/manager/live');
      expect(hit!.queryParameters['zone'], 'z1');
      expect(s.riders, hasLength(4));
    });
  });
}
