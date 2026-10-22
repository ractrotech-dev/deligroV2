import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/routing.dart';
import '../../models/jobs.dart';
import '../../theme/app_theme.dart';

/// OSM tiles on the map. Off under `flutter test`, which has neither a network
/// nor the tile cache's directory (path_provider): a widget test of any screen
/// that shows a delivery would otherwise fail on the map's plumbing.
final mapTilesEnabledProvider = Provider<bool>(
  (_) => kIsWeb || Platform.environment['FLUTTER_TEST'] != 'true',
);

LatLng _ll(LatLngPoint p) => LatLng(p.lat, p.lng);

/// The rider, the shop and the drop, with the route to the next stop. Tiles,
/// attribution and pins as the customer app's tracking map has them.
class RouteMap extends ConsumerStatefulWidget {
  const RouteMap({
    super.key,
    required this.shop,
    required this.drop,
    this.rider,
    this.plan,
    this.toShop = true,
    this.height = 190,
  });

  final LatLngPoint? shop;
  final LatLngPoint? drop;
  final LatLngPoint? rider;
  final RoutePlan? plan;

  /// The next stop is the shop (before pickup); otherwise the drop.
  final bool toShop;
  final double height;

  @override
  ConsumerState<RouteMap> createState() => _RouteMapState();
}

class _RouteMapState extends ConsumerState<RouteMap> {
  final _controller = MapController();

  /// One for the map's life. Left to itself, TileLayer makes a new provider
  /// (and HTTP client) on every rebuild, and every GPS fix is a rebuild.
  final _tiles = NetworkTileProvider();
  bool _ready = false;
  String _fittedFor = '';

  List<LatLng> _points() => [
        for (final p in [widget.shop, widget.drop, widget.rider])
          if (p != null) _ll(p),
      ];

  /// What the camera is fitted to: which pins exist and which leg it is.
  String _shape() =>
      '${widget.shop != null}${widget.drop != null}${widget.rider != null}${widget.toShop}';

  CameraFit _fit(List<LatLng> pts) => CameraFit.bounds(
        bounds: LatLngBounds.fromPoints(pts),
        padding: const EdgeInsets.fromLTRB(36, 36, 36, 30),
        maxZoom: 17,
      );

  @override
  void didUpdateWidget(covariant RouteMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Refit when a pin appears or the leg changes, not on every fix: that
    // would fight the rider's own panning.
    final shape = _shape();
    if (!_ready || shape == _fittedFor) return;
    final pts = _points();
    if (pts.length < 2) return;
    _fittedFor = shape;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      try {
        _controller.fitCamera(_fit(pts));
      } catch (_) {
        // Not attached yet; the next change retries.
      }
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    // TileLayer disposes its provider too; closing the client twice is safe.
    _tiles.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final pts = _points();
    if (pts.isEmpty) return const SizedBox.shrink();
    final tiles = ref.watch(mapTilesEnabledProvider);
    final plan = widget.plan;

    return ClipRRect(
      key: const Key('route-map'),
      borderRadius: BorderRadius.circular(radiusBlock),
      child: SizedBox(
        height: widget.height,
        child: FlutterMap(
          mapController: _controller,
          options: MapOptions(
            initialCenter: pts.first,
            initialZoom: 15,
            initialCameraFit: pts.length > 1 ? _fit(pts) : null,
            backgroundColor: c.surface2,
            // No one-finger panning: the map sits in a scrolling page, and a
            // thumb dragging the page up must move the page, not the map.
            // Zoom stays (pinch, double tap); Navigate is for finding the way.
            interactionOptions: const InteractionOptions(
              flags: InteractiveFlag.pinchZoom | InteractiveFlag.doubleTapZoom,
            ),
            onMapReady: () {
              _ready = true;
              _fittedFor = _shape();
            },
          ),
          children: [
            if (tiles)
              TileLayer(
                urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                userAgentPackageName: 'com.ractrotech.deligro.rider',
                tileProvider: _tiles,
              ),
            if (plan != null && plan.points.length > 1)
              PolylineLayer(polylines: [
                Polyline(
                  points: plan.points.map(_ll).toList(),
                  color: (plan.approx ? c.muted : c.blue).withValues(alpha: .85),
                  strokeWidth: plan.approx ? 3 : 5,
                  pattern: plan.approx ? StrokePattern.dashed(segments: const [10, 8]) : const StrokePattern.solid(),
                ),
              ]),
            MarkerLayer(markers: [
              if (widget.shop != null)
                Marker(
                  point: _ll(widget.shop!),
                  width: 40,
                  height: 40,
                  child: _Pin(
                    icon: Icons.storefront_rounded,
                    color: widget.toShop ? c.accent : c.surface2,
                    fg: widget.toShop ? c.onAccent : c.muted,
                    label: 'Shop',
                  ),
                ),
              if (widget.drop != null)
                Marker(
                  point: _ll(widget.drop!),
                  width: 40,
                  height: 40,
                  child: _Pin(
                    icon: Icons.home_rounded,
                    color: widget.toShop ? c.surface2 : c.ink,
                    fg: widget.toShop ? c.muted : c.bg,
                    label: 'Customer',
                  ),
                ),
              if (widget.rider != null)
                Marker(
                  point: _ll(widget.rider!),
                  width: 40,
                  height: 40,
                  child: _Pin(icon: Icons.two_wheeler_rounded, color: c.green, fg: Colors.white, label: 'You'),
                ),
            ]),
            if (tiles)
              RichAttributionWidget(
                attributions: [
                  TextSourceAttribution(
                    'OpenStreetMap contributors',
                    onTap: () => launchUrl(Uri.parse('https://openstreetmap.org/copyright')),
                  ),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

class _Pin extends StatelessWidget {
  const _Pin({required this.icon, required this.color, required this.fg, required this.label});

  final IconData icon;
  final Color color;
  final Color fg;
  final String label;

  @override
  Widget build(BuildContext context) => Semantics(
        label: label,
        child: Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            color: color,
            shape: BoxShape.circle,
            border: Border.all(color: Colors.white, width: 2.5),
            boxShadow: const [BoxShadow(color: Color(0x40000000), blurRadius: 6, offset: Offset(0, 2))],
          ),
          child: Icon(icon, size: 18, color: fg),
        ),
      );
}
