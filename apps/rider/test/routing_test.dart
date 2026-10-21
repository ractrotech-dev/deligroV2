// Routing for the active delivery: the OSRM answer, the straight-line fallback
// when the routing server cannot be reached, and when a route is stale. No
// network: the HTTP client is a MockClient.
import 'dart:convert';
import 'dart:math';

import 'package:deligro_rider/core/geo.dart';
import 'package:deligro_rider/core/routing.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _shop = (lat: 21.7189, lng: 81.5301);
const _drop = (lat: 21.7102, lng: 81.5398);

Map<String, dynamic> _osrm() => {
      'code': 'Ok',
      'routes': [
        {
          'geometry': {
            'type': 'LineString',
            'coordinates': [
              [81.5301, 21.7189],
              [81.5350, 21.7150],
              [81.5398, 21.7102],
            ],
          },
          'distance': 2614.3,
          'duration': 412.5,
          'legs': [],
        },
      ],
      'waypoints': [],
    };

/// [meters] east of [p], on the earth [haversineKm] measures.
({double lat, double lng}) _east(({double lat, double lng}) p, double meters) {
  const r = 6371000.0;
  final dLng = meters / (r * cos(p.lat * pi / 180)) * 180 / pi;
  return (lat: p.lat, lng: p.lng + dLng);
}

void main() {
  group('the OSRM answer', () {
    test('parses the geometry (lng,lat pairs), distance and duration', () {
      final plan = parseOsrmRoute(_osrm())!;
      expect(plan.points, [
        (lat: 21.7189, lng: 81.5301),
        (lat: 21.7150, lng: 81.5350),
        (lat: 21.7102, lng: 81.5398),
      ]);
      expect(plan.distanceKm, closeTo(2.6143, 1e-9));
      expect(plan.etaMinutes, 7, reason: '412.5 s rounds up to 7 min');
      expect(plan.approx, isFalse);
    });

    test('anything but a route is no route', () {
      expect(parseOsrmRoute({'code': 'NoRoute', 'routes': []}), isNull);
      expect(parseOsrmRoute({'code': 'Ok', 'routes': []}), isNull);
      expect(parseOsrmRoute({'code': 'Ok'}), isNull);
      expect(parseOsrmRoute('nonsense'), isNull);
      expect(
        parseOsrmRoute({
          'code': 'Ok',
          'routes': [
            {'geometry': {'coordinates': [[81.5, 21.7]]}, 'distance': 'far', 'duration': 10},
          ],
        }),
        isNull,
      );
    });

    test('the request is the routing base URL, lng,lat;lng,lat, simplified geojson', () {
      expect(
        osrmRouteUri('https://router.example.org/', _shop, _drop).toString(),
        'https://router.example.org/route/v1/driving/81.5301,21.7189;81.5398,21.7102'
        '?overview=simplified&geometries=geojson',
      );
      expect(defaultRoutingBaseUrl, 'https://router.project-osrm.org');
    });
  });

  group('RoutingClient', () {
    test('asks the routing server and returns its route', () async {
      final asked = <Uri>[];
      final client = RoutingClient(
        client: MockClient((req) async {
          asked.add(req.url);
          return http.Response(jsonEncode(_osrm()), 200);
        }),
      );
      final plan = await client.route('https://router.example.org', _shop, _drop);
      expect(asked.single.path, '/route/v1/driving/81.5301,21.7189;81.5398,21.7102');
      expect(plan.approx, isFalse);
      expect(plan.points, hasLength(3));
    });

    for (final (name, handler) in <(String, MockClientHandler)>[
      ('a 500', (_) async => http.Response('oops', 500)),
      ('no connection', (_) async => throw http.ClientException('no route to host')),
      ('a NoRoute answer', (_) async => http.Response(jsonEncode({'code': 'NoRoute'}), 200)),
      ('a body that is not JSON', (_) async => http.Response('<html>', 200)),
    ]) {
      test('$name falls back to a straight line and a haversine ETA, marked approx.', () async {
        final plan = await RoutingClient(client: MockClient(handler)).route(defaultRoutingBaseUrl, _shop, _drop);
        expect(plan.approx, isTrue);
        expect(plan.points, [_shop, _drop]);
        final km = haversineKm(_shop.lat, _shop.lng, _drop.lat, _drop.lng);
        expect(plan.distanceKm, closeTo(km, 1e-9));
        expect(plan.etaMinutes, approxEtaMinutes(km));
      });
    }

    test('a routing server that never answers falls back after the timeout', () async {
      final plan = await RoutingClient(
        client: MockClient((_) => Future<http.Response>.delayed(const Duration(seconds: 5), () => http.Response('{}', 200))),
        timeout: const Duration(milliseconds: 20),
      ).route(defaultRoutingBaseUrl, _shop, _drop);
      expect(plan.approx, isTrue);
    });

    test('the haversine ETA is never zero minutes', () {
      expect(approxEtaMinutes(0), 1);
      expect(approxEtaMinutes(0.01), 1);
      expect(approxEtaMinutes(10), greaterThan(approxEtaMinutes(5)));
    });
  });

  group('off the route', () {
    final line = [_shop, (lat: 21.7150, lng: 81.5350), _drop];

    test('151 m from the line is off it; 149 m is not', () {
      final start = (lat: 21.7189, lng: 81.5301);
      final north = [start, (lat: 21.7389, lng: 81.5301)]; // due north, 2.2 km
      final mid = (lat: 21.7289, lng: 81.5301);
      expect(metersFromLine(_east(mid, 151), north), closeTo(151, 0.5));
      expect(isOffRoute(_east(mid, 151), north), isTrue);
      expect(isOffRoute(_east(mid, 149), north), isFalse);
      expect(offRouteMeters, 150);
    });

    test('on the line is zero; past an end it is the distance to that end', () {
      expect(metersFromLine(_shop, line), closeTo(0, 1e-6));
      final beyond = _east(_drop, 300);
      expect(metersFromLine(beyond, line), closeTo(300, 1));
    });

    test('a route of one point measures to that point; no route is always off', () {
      expect(metersFromLine(_east(_shop, 80), [_shop]), closeTo(80, 0.5));
      expect(isOffRoute(_shop, const []), isTrue);
    });
  });

  group('when to ask again', () {
    final at = DateTime.utc(2026, 10, 22, 9);
    final plan = RoutePlan(points: [_shop, _drop], distanceKm: 1.4, etaMinutes: 6);

    test('no route yet: ask', () {
      expect(needsReroute(plan: null, at: null, now: at, rider: _shop), isTrue);
    });

    test('on the line and fresh: keep it', () {
      expect(needsReroute(plan: plan, at: at, now: at.add(const Duration(seconds: 119)), rider: _shop), isFalse);
    });

    test('every 2 minutes', () {
      expect(needsReroute(plan: plan, at: at, now: at.add(const Duration(minutes: 2)), rider: _shop), isTrue);
    });

    test('more than 150 m off the line', () {
      final north = RoutePlan(points: [_shop, (lat: 21.7389, lng: 81.5301)], distanceKm: 2.2, etaMinutes: 8);
      final mid = (lat: 21.7289, lng: 81.5301);
      expect(needsReroute(plan: north, at: at, now: at, rider: _east(mid, 151)), isTrue);
      expect(needsReroute(plan: north, at: at, now: at, rider: _east(mid, 149)), isFalse);
    });
  });
}
