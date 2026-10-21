import 'dart:convert';
import 'dart:io';

import 'package:deligro_manager/models/live.dart';
import 'package:deligro_manager/models/orders.dart';
import 'package:flutter_test/flutter_test.dart';

/// Phase 3 contract check, app half. `scripts/qa/manager-contract-emit.ts`
/// runs the server's own serialisers and writes `fixtures/api/generated/`;
/// this test checks every field the app's models read is present with the
/// right type, then parses each file with the models and checks nothing fell
/// back to a default or `unknown`. The models are lenient on purpose, so a
/// renamed key would otherwise parse quietly into a blank screen.
///
///   npx tsx scripts/qa/manager-contract-emit.ts   (from the repo root)
///   flutter test test/contract_test.dart
Map<String, dynamic> _gen(String name) =>
    jsonDecode(File('test/fixtures/api/generated/$name.json').readAsStringSync()) as Map<String, dynamic>;

// ---- a small schema checker ------------------------------------------------
// A spec is 'str' | 'num' | 'int' | 'bool' | 'any' (append '?' for nullable),
// a Map<String, Object> (an object; key ending in '~' may be absent), or
// _ListOf(spec). Extra keys from the server are fine; missing ones are not.

class _ListOf {
  const _ListOf(this.of);
  final Object of;
}

class _Nullable {
  const _Nullable(this.of);
  final Object of;
}

void _check(Object spec, Object? value, String path, List<String> errors) {
  if (spec is _Nullable) {
    if (value == null) return;
    return _check(spec.of, value, path, errors);
  }
  if (spec is String) {
    final nullable = spec.endsWith('?');
    final t = nullable ? spec.substring(0, spec.length - 1) : spec;
    if (value == null) {
      if (!nullable) errors.add('$path: null, expected $t');
      return;
    }
    final ok = switch (t) {
      'str' => value is String,
      'num' => value is num,
      'int' => value is int,
      'bool' => value is bool,
      _ => true,
    };
    if (!ok) errors.add('$path: ${value.runtimeType}, expected $t');
    return;
  }
  if (spec is _ListOf) {
    if (value is! List) return errors.add('$path: ${value.runtimeType}, expected list');
    for (var i = 0; i < value.length; i++) {
      _check(spec.of, value[i], '$path[$i]', errors);
    }
    return;
  }
  if (spec is Map<String, Object>) {
    if (value is! Map) return errors.add('$path: ${value.runtimeType}, expected object');
    for (final e in spec.entries) {
      final optional = e.key.endsWith('~');
      final key = optional ? e.key.substring(0, e.key.length - 1) : e.key;
      if (!value.containsKey(key)) {
        if (!optional) errors.add('$path.$key: missing');
        continue;
      }
      _check(e.value, value[key], '$path.$key', errors);
    }
  }
}

void _expectShape(Object spec, Object? value, String name) {
  final errors = <String>[];
  _check(spec, value, name, errors);
  expect(errors, isEmpty, reason: errors.join('\n'));
}

// ---- the pinned shapes, as the models read them -----------------------------

const _riderRef = {'id': 'str', 'name': 'str', 'code': 'str?'};
const Map<String, Object> _listItem = {
  'id': 'str',
  'code': 'str',
  'status': 'str',
  'createdAt': 'str',
  'zoneId': 'str?',
  'vendor': {'id': 'str', 'name': 'str'},
  'customerName': 'str?',
  'total': 'num',
  'itemCount': 'int',
  'payment': {'method': 'str?', 'status': 'str?'},
  'rider': _Nullable(_riderRef),
  'deliveryStatus': 'str?',
  'byPhone': 'bool',
  'eta': _Nullable({'pickupAt': 'str?', 'expectedAt': 'str?', 'dueAt': 'str?', 'late': 'bool', 'lateByMinutes': 'int?'}),
  'delay': _Nullable({'kind': 'str', 'minutes': 'int'}),
  'cancellation': _Nullable({'by': 'str?', 'reason': 'str?', 'at': 'str?'}),
};
const Map<String, Object> _page = {
  'items': _ListOf(_listItem),
  'nextCursor': 'str?',
  'counts': {'delayed': 'int', 'unassigned': 'int'},
};
final Map<String, Object> _detail = {
  ..._listItem,
  'items': const _ListOf({'id': 'str', 'name': 'str', 'qty': 'int', 'price': 'num', 'lineTotal': 'num'}),
  'money': const {'subtotal': 'num', 'discount': 'num', 'deliveryFee': 'num', 'tax': 'num', 'tip': 'num', 'total': 'num'},
  'pickup': const {'name': 'str', 'address': 'str?', 'lat': 'num?', 'lng': 'num?', 'phone': 'str?'},
  'drop': const {'label': 'str?', 'address': 'str?', 'landmark': 'str?', 'lat': 'num?', 'lng': 'num?'},
  // `phone` exists only with manager.call_customer — absent, never null.
  'customer': const {'name': 'str?', 'phone~': 'str?'},
  'delivery': const _Nullable({
    'id': 'str',
    'status': 'str',
    'rider': _Nullable({'id': 'str', 'name': 'str', 'code': 'str?', 'phone': 'str?'}),
    'offeredTo': _Nullable({'id': 'str', 'name': 'str'}),
    'assignedAt': 'str?',
    'pickedUpAt': 'str?',
    'deliveredAt': 'str?',
    'failedAt': 'str?',
    'failureReason': 'str?',
    'lastFix': _Nullable({'lat': 'num', 'lng': 'num', 'at': 'str', 'ageSeconds': 'int'}),
  }),
  'timeline': const _ListOf({
    'at': 'str',
    'source': 'str',
    'kind': 'str',
    'from': 'str?',
    'to': 'str?',
    'actor': _Nullable({'id': 'str', 'name': 'str', 'role': 'str'}),
    'reason': 'str?',
    'method': 'str?',
  }),
  'tickets': const _ListOf({'id': 'str', 'number': 'int', 'status': 'str', 'priority': 'str'}),
  'allowed': const {
    'advance': 'str?',
    'cancel': 'bool',
    'assign': 'bool',
    'reassign': 'bool',
    'escalate': 'bool',
    'correct': 'bool',
    'note': 'bool',
  },
};
const Map<String, Object> _candidate = {
  'id': 'str',
  'name': 'str',
  'code': 'str?',
  'phase': 'str',
  'activeDeliveries': 'int',
  'distanceKm': 'num?',
  'lastFixAgeSeconds': 'int?',
  'eligible': 'bool',
  'ineligibleReason': 'str?',
};
const _point = _Nullable({'lat': 'num', 'lng': 'num'});
final Map<String, Object> _live = {
  'generatedAt': 'str',
  'riders': const _ListOf({
    'id': 'str',
    'name': 'str',
    'code': 'str?',
    'state': 'str',
    'lat': 'num?',
    'lng': 'num?',
    'lastFixAt': 'str?',
    'lastFixAgeSeconds': 'int?',
    'stale': 'bool',
    'activeOrderIds': _ListOf('str'),
    'phone': 'str?',
  }),
  'orders': _ListOf({..._listItem, 'pickupPoint': _point, 'dropPoint': _point}),
  'lanes': const {'placed': 'int', 'kitchen': 'int', 'ready': 'int', 'on_the_way': 'int'},
  'unassigned': const _ListOf('str'),
  'delayed': const _ListOf({'orderId': 'str', 'kind': 'str', 'minutes': 'int'}),
  'signals': const _ListOf({'kind': 'str', 'orderId~': 'str?', 'riderId~': 'str?', 'minutes~': 'int?', 'at~': 'str?'}),
  'thresholds': const {
    'staleSeconds': 'int',
    'inactiveMinutes': 'int',
    'unassignedMinutes': 'int',
    'prepGraceMinutes': 'int',
    'pickupWaitMinutes': 'int',
  },
};

void _expectListItemParsed(OrderListItem m, Map<String, dynamic> j) {
  expect(m.id, j['id']);
  expect(m.status, isNot(OrderStatus.unknown), reason: 'status ${j['status']}');
  if (j['deliveryStatus'] != null) expect(m.deliveryStatus, isNot(DeliveryStatus.unknown));
  final pay = j['payment'] as Map;
  if (pay['method'] != null) expect(m.payment.method, isNot(PaymentMethod.unknown));
  if (pay['status'] != null) expect(m.payment.status, isNot(PaymentStatus.unknown));
  if (j['delay'] != null) expect(m.delay!.kind, isNot(DelayKind.unknown));
  if (j['cancellation'] != null) {
    final by = (j['cancellation'] as Map)['by'];
    if (by != null) expect(m.cancellation?.by, isNotNull, reason: 'cancelled by "$by" not understood');
  }
  if (j['rider'] != null) expect(m.rider?.id, (j['rider'] as Map)['id']);
}

void main() {
  test('generated fixtures exist (run the emitter first)', () {
    for (final f in [
      'orders_list',
      'orders_list_last_page',
      'order_detail',
      'order_detail_no_phone',
      'order_detail_cancelled',
      'order_riders',
      'live',
      'order_actions',
    ]) {
      expect(File('test/fixtures/api/generated/$f.json').existsSync(), isTrue, reason: f);
    }
  });

  group('GET /api/manager/orders', () {
    for (final name in ['orders_list', 'orders_list_last_page']) {
      test('$name has every field the app reads, and parses', () {
        final j = _gen(name);
        _expectShape(_page, j, name);
        final page = OrderPage.fromJson(j);
        final items = (j['items'] as List).cast<Map<String, dynamic>>();
        expect(page.items.length, items.length);
        for (var i = 0; i < items.length; i++) {
          _expectListItemParsed(page.items[i], items[i]);
        }
        expect(page.nextCursor, j['nextCursor']);
      });
    }

    test('the list covers every order status the board shows', () {
      final page = OrderPage.fromJson(_gen('orders_list'));
      expect(
        page.items.map((o) => o.status).toSet(),
        containsAll([
          OrderStatus.placed,
          OrderStatus.kitchen,
          OrderStatus.ready,
          OrderStatus.onTheWay,
          OrderStatus.delivered,
          OrderStatus.cancelled,
        ]),
      );
      final cancelled = page.items.firstWhere((o) => o.status == OrderStatus.cancelled);
      expect(cancelled.cancellation?.reason, 'Out of stock');
      expect(cancelled.cancellation?.by, CancelledBy.vendor);
    });
  });

  group('GET /api/manager/orders/[id]', () {
    for (final name in ['order_detail', 'order_detail_no_phone', 'order_detail_cancelled']) {
      test('$name has every field the app reads, and parses', () {
        final body = _gen(name);
        final j = (body['order'] as Map).cast<String, dynamic>();
        _expectShape(_detail, j, name);
        final d = OrderDetail.fromJson(j);
        _expectListItemParsed(d.summary, j);
        final items = (j['items'] as List).cast<Map<String, dynamic>>();
        expect(d.items.map((i) => i.id).toList(), items.map((i) => i['id']).toList());
        for (final e in d.timeline) {
          expect(e.actor?.role, isNot(ActorRole.unknown));
        }
      });
    }

    test('item ids reach the model (enables the item-unavailable correction)', () {
      final d = OrderDetail.fromJson((_gen('order_detail')['order'] as Map).cast<String, dynamic>());
      expect(d.items, isNotEmpty);
      expect(d.items.every((i) => i.id != null && i.id!.isNotEmpty), isTrue);
    });

    test('customer phone: present with the permission, absent without', () {
      final withPhone = (_gen('order_detail')['order'] as Map)['customer'] as Map;
      final without = (_gen('order_detail_no_phone')['order'] as Map)['customer'] as Map;
      expect(withPhone.containsKey('phone'), isTrue);
      expect(without.containsKey('phone'), isFalse);
      expect(
        OrderDetail.fromJson((_gen('order_detail_no_phone')['order'] as Map).cast<String, dynamic>()).customer.phone,
        isNull,
      );
    });

    test('ops timeline entries (corrected, escalated, reassigned) parse with their fields', () {
      final d = OrderDetail.fromJson((_gen('order_detail')['order'] as Map).cast<String, dynamic>());
      final kinds = d.timeline.map((e) => e.kind).toSet();
      expect(kinds, containsAll(['corrected', 'escalated', 'reassigned', 'note']));
      final corrected = d.timeline.firstWhere((e) => e.kind == 'corrected');
      expect([corrected.from, corrected.to, corrected.method], ['ready', 'kitchen', 'status']);
    });
  });

  test('GET /api/manager/orders/[id]/riders has every field the app reads, and parses', () {
    final j = _gen('order_riders');
    _expectShape({'riders': const _ListOf(_candidate)}, j, 'order_riders');
    final list = parseRiderCandidates(j);
    final raw = (j['riders'] as List).cast<Map<String, dynamic>>();
    expect(list.map((r) => r.id).toList(), raw.map((r) => r['id']).toList());
    for (var i = 0; i < raw.length; i++) {
      if (raw[i]['ineligibleReason'] != null) {
        expect(list[i].ineligibleReason, isNot(IneligibleReason.unknown), reason: '${raw[i]['ineligibleReason']}');
      }
      expect(list[i].phase, raw[i]['phase']);
    }
    expect(list.first.eligible, isTrue, reason: 'eligible riders sort first');
    expect(list.any((r) => !r.eligible), isTrue);
  });

  group('GET /api/manager/live', () {
    test('has every field the app reads, and parses', () {
      final j = _gen('live');
      _expectShape(_live, j, 'live');
      final s = LiveSnapshot.fromJson(j);
      final riders = (j['riders'] as List).cast<Map<String, dynamic>>();
      expect(s.riders.length, riders.length);
      for (var i = 0; i < riders.length; i++) {
        expect(s.riders[i].state, isNot(RiderState.unknown), reason: '${riders[i]['state']}');
        expect(s.riders[i].phone, riders[i]['phone']);
      }
      final orders = (j['orders'] as List).cast<Map<String, dynamic>>();
      for (var i = 0; i < orders.length; i++) {
        _expectListItemParsed(s.orders[i].item, orders[i]);
      }
      for (final sig in s.signals) {
        expect(sig.kind, isNot(SignalKind.unknown));
      }
      for (final d in s.delayed) {
        expect(d.kind, isNot(DelayKind.unknown));
      }
      final t = j['thresholds'] as Map;
      expect(s.thresholds.staleSeconds, t['staleSeconds']);
      expect(s.thresholds.pickupWaitMinutes, t['pickupWaitMinutes']);
    });

    test('a rider on a break and a stale rider are both in the snapshot', () {
      final s = LiveSnapshot.fromJson(_gen('live'));
      expect(s.riders.any((r) => r.state == RiderState.onBreak), isTrue);
      expect(s.riders.any((r) => r.stale), isTrue);
    });

    test('the rider phone follows the call rule (out-of-zone rider has none)', () {
      final s = LiveSnapshot.fromJson(_gen('live'));
      expect(s.riders.firstWhere((r) => r.name == 'Visitor').phone, isNull);
      expect(s.riders.firstWhere((r) => r.name == 'Ravi').phone, isNotNull);
    });
  });

  group('POST /api/manager/orders/[id]/actions', () {
    test('success bodies carry a parseable order (and a ticket when escalating)', () {
      final a = _gen('order_actions');
      for (final k in ['ok', 'okEscalated']) {
        final body = (a[k] as Map).cast<String, dynamic>();
        expect(body['ok'], isTrue);
        _expectShape(_detail, body['order'], k);
      }
      final esc = (a['okEscalated'] as Map)['ticket'] as Map;
      expect(TicketRef.fromJson(esc.cast<String, dynamic>())?.number, isNotNull);
      expect((a['okReReadFailed'] as Map)['order'], isNull);
    });

    test('refusals carry an error code, and a field when one parameter is to blame', () {
      final a = _gen('order_actions');
      _expectShape({'error': 'str', 'current~': 'str?'}, a['conflict'], 'conflict');
      _expectShape({'error': 'str', 'field': 'str'}, a['badField'], 'badField');
      _expectShape({'error': 'str'}, a['failed'], 'failed');
    });
  });
}
