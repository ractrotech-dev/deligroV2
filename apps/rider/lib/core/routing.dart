import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../models/jobs.dart';
import 'geo.dart';

/// The public OSRM server: what `platform_settings.routing_base_url` defaults to
/// (src/lib/settings-defaults.ts). The board does not send the setting yet, so
/// the app uses this unless a board names one (`routingBaseUrl`).
const defaultRoutingBaseUrl = 'https://router.project-osrm.org';

/// Further than this from the route line and the route is asked for again.
const offRouteMeters = 150.0;

/// A route this old is asked for again even if the rider kept to it.
const rerouteEvery = Duration(minutes: 2);

/// Straight-line km to road km, the same factor the server falls back to.
const _roadFactor = 1.3;

/// A rider's average speed in town, for an ETA with no routing server.
const _approxKmh = 20.0;

/// A way from the rider to the stop, as drawn on the map.
@immutable
class RoutePlan {
  const RoutePlan({required this.points, required this.distanceKm, required this.etaMinutes, this.approx = false});

  final List<LatLngPoint> points;
  final double distanceKm;
  final int etaMinutes;

  /// A straight line with a guessed ETA: the routing server did not answer.
  /// The screen says "approx.".
  final bool approx;
}

/// Minutes for [km] in a straight line, guessed: never zero.
int approxEtaMinutes(double km) => max(1, (km * _roadFactor / _approxKmh * 60).ceil());

/// `GET <base>/route/v1/driving/<lng,lat;lng,lat>?overview=simplified&geometries=geojson`.
Uri osrmRouteUri(String baseUrl, LatLngPoint from, LatLngPoint to) {
  final base = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl;
  return Uri.parse('$base/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}'
      '?overview=simplified&geometries=geojson');
}

/// The first route of an OSRM answer, or null for anything else.
RoutePlan? parseOsrmRoute(Object? json) {
  if (json is! Map || json['code'] != 'Ok') return null;
  final routes = json['routes'];
  if (routes is! List || routes.isEmpty || routes.first is! Map) return null;
  final route = routes.first as Map;
  final distance = route['distance'];
  final duration = route['duration'];
  final geometry = route['geometry'];
  if (distance is! num || duration is! num || geometry is! Map) return null;
  final coords = geometry['coordinates'];
  if (coords is! List || coords.isEmpty) return null;
  final points = <LatLngPoint>[];
  for (final c in coords) {
    if (c is! List || c.length < 2 || c[0] is! num || c[1] is! num) return null;
    points.add((lat: (c[1] as num).toDouble(), lng: (c[0] as num).toDouble()));
  }
  return RoutePlan(
    points: points,
    distanceKm: distance / 1000,
    etaMinutes: max(1, (duration / 60).ceil()),
  );
}

/// The fallback: a straight line and a haversine ETA, marked approx.
RoutePlan straightLine(LatLngPoint from, LatLngPoint to) {
  final km = haversineKm(from.lat, from.lng, to.lat, to.lng);
  return RoutePlan(points: [from, to], distanceKm: km, etaMinutes: approxEtaMinutes(km), approx: true);
}

const _earthM = 6371000.0;

/// Metres from [p] to the nearest point of [line]: each segment on a flat
/// projection around [p], which at a few kilometres is well inside a metre.
/// An empty line is infinitely far.
double metersFromLine(LatLngPoint p, List<LatLngPoint> line) {
  if (line.isEmpty) return double.infinity;
  final k = cos(p.lat * pi / 180);
  (double, double) xy(LatLngPoint q) =>
      ((q.lng - p.lng) * pi / 180 * _earthM * k, (q.lat - p.lat) * pi / 180 * _earthM);
  if (line.length == 1) {
    final (x, y) = xy(line.first);
    return sqrt(x * x + y * y);
  }
  var best = double.infinity;
  for (var i = 0; i < line.length - 1; i++) {
    final (ax, ay) = xy(line[i]);
    final (bx, by) = xy(line[i + 1]);
    final dx = bx - ax;
    final dy = by - ay;
    final len2 = dx * dx + dy * dy;
    // The foot of the perpendicular from the origin (p), kept on the segment.
    final t = len2 == 0 ? 0.0 : (-(ax * dx + ay * dy) / len2).clamp(0.0, 1.0);
    final cx = ax + t * dx;
    final cy = ay + t * dy;
    best = min(best, sqrt(cx * cx + cy * cy));
  }
  return best;
}

bool isOffRoute(LatLngPoint p, List<LatLngPoint> line, {double limit = offRouteMeters}) =>
    metersFromLine(p, line) > limit;

/// Whether to ask for the route again: none yet, two minutes old, or the rider
/// is more than 150 m off it.
bool needsReroute({
  required RoutePlan? plan,
  required DateTime? at,
  required DateTime now,
  LatLngPoint? rider,
}) {
  if (plan == null || at == null) return true;
  if (now.difference(at) >= rerouteEvery) return true;
  return rider != null && isOffRoute(rider, plan.points);
}

/// Asks an OSRM server for the way. Never throws and never waits long: any
/// failure is the straight line.
class RoutingClient {
  RoutingClient({http.Client? client, this.timeout = const Duration(seconds: 8)}) : _http = client ?? http.Client();

  final http.Client _http;
  final Duration timeout;

  Future<RoutePlan> route(String baseUrl, LatLngPoint from, LatLngPoint to) async {
    try {
      final res = await _http.get(osrmRouteUri(baseUrl, from, to)).timeout(timeout);
      if (res.statusCode == 200) {
        final plan = parseOsrmRoute(jsonDecode(res.body));
        if (plan != null) return plan;
      }
    } catch (e) {
      debugPrint('routing: $e');
    }
    return straightLine(from, to);
  }
}

final routingClientProvider = Provider<RoutingClient>((_) => RoutingClient());
