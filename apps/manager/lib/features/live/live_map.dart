import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';

import '../../models/live.dart';
import '../../models/orders.dart';
import '../../theme/app_theme.dart';
import '../orders/order_labels.dart';
import '../orders/order_mini_map.dart';

/// Bemetara, for a board with nothing on it yet.
const _fallbackCenter = LatLng(21.7151, 81.5352);

/// The rider's marker colour (§6.1): available green, on delivery the
/// accent, on a break violet (no order pin uses it), stale grey (§6.12).
Color riderColor(AppColors c, LiveRider r) {
  if (r.stale || r.state == RiderState.stale) return c.muted;
  return switch (r.state) {
    RiderState.available => c.green,
    RiderState.onDelivery => c.accent,
    RiderState.onBreak => c.violet,
    _ => c.muted,
  };
}

String riderStateLabel(LiveRider r) {
  if (r.stale || r.state == RiderState.stale) return 'Location out of date';
  return switch (r.state) {
    RiderState.available => 'Available',
    RiderState.onDelivery => 'On a delivery',
    RiderState.onBreak => 'On a break',
    _ => 'Unknown',
  };
}

/// Riders and active orders on one map: rider markers coloured by state
/// (stale ones grey with "updated N min ago"), each active order's shop as a
/// status-coloured pin with a line to the drop while it is on the way.
class LiveMap extends ConsumerStatefulWidget {
  const LiveMap({
    super.key,
    required this.snapshot,
    required this.onRider,
    required this.onOrder,
    this.focusOrderId,
    this.bottomInset = 0,
  });

  final LiveSnapshot snapshot;
  final void Function(LiveRider rider) onRider;
  final void Function(LiveOrder order) onOrder;

  /// Centre on this order once (from a push or a dashboard tile).
  final String? focusOrderId;

  /// Height covered by the bottom panel, so "fit all" keeps pins visible.
  final double bottomInset;

  @override
  ConsumerState<LiveMap> createState() => _LiveMapState();
}

class _LiveMapState extends ConsumerState<LiveMap> {
  final _map = MapController();
  bool _ready = false;
  String? _focused;

  List<LatLng> get _points => [
        for (final r in widget.snapshot.riders)
          if (r.hasPoint) LatLng(r.lat!, r.lng!),
        for (final o in widget.snapshot.orders) ...[
          if (o.pickupPoint != null) LatLng(o.pickupPoint!.lat, o.pickupPoint!.lng),
          if (o.dropPoint != null) LatLng(o.dropPoint!.lat, o.dropPoint!.lng),
        ],
      ];

  EdgeInsets get _padding => EdgeInsets.fromLTRB(40, 40, 40, 40 + widget.bottomInset);

  void _fitAll() {
    final pts = _points;
    if (!_ready || pts.isEmpty) return;
    if (pts.length == 1) {
      _map.move(pts.first, 15);
    } else {
      _map.fitCamera(CameraFit.coordinates(coordinates: pts, padding: _padding, maxZoom: 16));
    }
  }

  void _focus() {
    final id = widget.focusOrderId;
    if (!_ready || id == null || id == _focused) return;
    final o = widget.snapshot.order(id);
    if (o == null) return;
    _focused = id;
    final rider = o.item.rider == null ? null : widget.snapshot.rider(o.item.rider!.id);
    final p = rider != null && rider.hasPoint
        ? LatLng(rider.lat!, rider.lng!)
        : o.pickupPoint != null
            ? LatLng(o.pickupPoint!.lat, o.pickupPoint!.lng)
            : null;
    if (p != null) _map.move(p, 16);
  }

  @override
  void didUpdateWidget(LiveMap old) {
    super.didUpdateWidget(old);
    if (widget.focusOrderId != old.focusOrderId) _focus();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = widget.snapshot;
    final pts = _points;
    final tiles = ref.watch(mapTilesEnabledProvider);
    return Stack(
      children: [
        FlutterMap(
          mapController: _map,
          options: MapOptions(
            initialCenter: pts.isEmpty ? _fallbackCenter : pts.first,
            initialZoom: 14,
            initialCameraFit:
                pts.length < 2 ? null : CameraFit.coordinates(coordinates: pts, padding: _padding, maxZoom: 16),
            interactionOptions: const InteractionOptions(flags: InteractiveFlag.all & ~InteractiveFlag.rotate),
            onMapReady: () {
              _ready = true;
              _focus();
            },
          ),
          children: [
            if (tiles) osmTiles(),
            PolylineLayer(polylines: [
              for (final o in s.orders)
                if (o.item.status == OrderStatus.onTheWay && o.pickupPoint != null && o.dropPoint != null)
                  Polyline(
                    points: [
                      LatLng(o.pickupPoint!.lat, o.pickupPoint!.lng),
                      LatLng(o.dropPoint!.lat, o.dropPoint!.lng),
                    ],
                    color: c.blue.withValues(alpha: .6),
                    strokeWidth: 3,
                    pattern: StrokePattern.dashed(segments: const [10, 8]),
                  ),
            ]),
            MarkerLayer(markers: [
              for (final o in s.orders)
                if (o.pickupPoint != null)
                  Marker(
                    point: LatLng(o.pickupPoint!.lat, o.pickupPoint!.lng),
                    width: 34,
                    height: 34,
                    child: GestureDetector(
                      key: Key('order-pin-${o.item.id}'),
                      onTap: () => widget.onOrder(o),
                      child: MapPin(
                        icon: Icons.storefront_rounded,
                        color: statusColor(c, o.item.status),
                        fg: Colors.white,
                        label: '${o.item.code}, ${statusLabel(o.item.status)}',
                      ),
                    ),
                  ),
              for (final r in s.riders)
                if (r.hasPoint)
                  Marker(
                    point: LatLng(r.lat!, r.lng!),
                    width: 130,
                    height: r.stale ? 80 : 34,
                    // Keeps the pin, not the label under it, on the rider's point.
                    alignment: r.stale ? const Alignment(0, 0.575) : Alignment.center,
                    child: GestureDetector(
                      key: Key('rider-marker-${r.id}'),
                      onTap: () => widget.onRider(r),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          SizedBox(
                            width: 34,
                            height: 34,
                            child: MapPin(
                              icon: Icons.two_wheeler,
                              color: riderColor(c, r),
                              fg: Colors.white,
                              label: '${r.name}, ${riderStateLabel(r)}',
                            ),
                          ),
                          if (r.stale)
                            Container(
                              margin: const EdgeInsets.only(top: 3),
                              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                              decoration: BoxDecoration(
                                color: c.surface,
                                borderRadius: BorderRadius.circular(6),
                                border: Border.all(color: c.line),
                              ),
                              child: Text(
                                fixAgeText(r.lastFixAgeSeconds),
                                style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: c.muted),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
            ]),
          ],
        ),
        Positioned(
          right: 12,
          top: 12,
          child: FloatingActionButton.small(
            key: const Key('live-fit'),
            heroTag: 'live-fit',
            tooltip: 'Fit all',
            backgroundColor: c.surface,
            foregroundColor: c.ink,
            onPressed: _fitAll,
            child: const Icon(Icons.fit_screen),
          ),
        ),
      ],
    );
  }
}
