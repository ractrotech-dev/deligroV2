import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';

import '../../theme/app_theme.dart';

/// Whether maps load OpenStreetMap tiles. Always true in the app; widget
/// tests turn it off so a map draws its pins without touching the network.
final mapTilesEnabledProvider = Provider<bool>((_) => true);

/// The OSM tile layer every map in the app uses (the customer app's source,
/// with this app's package as the user agent, per OSM's tile policy).
Widget osmTiles() => TileLayer(
      urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      userAgentPackageName: 'com.ractrotech.deligro.manager',
    );

/// A round pin with an icon — shop, drop or rider.
class MapPin extends StatelessWidget {
  const MapPin({super.key, required this.icon, required this.color, required this.fg, this.label});
  final IconData icon;
  final Color color;
  final Color fg;
  final String? label;

  @override
  Widget build(BuildContext context) => Semantics(
        label: label,
        child: Container(
          decoration: BoxDecoration(
            color: color,
            shape: BoxShape.circle,
            border: Border.all(color: Colors.white, width: 2),
            boxShadow: const [BoxShadow(color: Color(0x33000000), blurRadius: 4, offset: Offset(0, 1))],
          ),
          child: Icon(icon, size: 18, color: fg),
        ),
      );
}

/// The order's shop, drop and (while it is moving) rider on a small map —
/// §3.11 "track assigned riders and delivery progress". The rider pin is grey
/// when its fix is stale.
class OrderMiniMap extends ConsumerWidget {
  const OrderMiniMap({super.key, this.shop, this.drop, this.rider, this.riderStale = false, this.height = 190});

  final LatLng? shop;
  final LatLng? drop;
  final LatLng? rider;
  final bool riderStale;
  final double height;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final points = [?shop, ?drop, ?rider];
    if (points.isEmpty) return const SizedBox.shrink();
    final tiles = ref.watch(mapTilesEnabledProvider);
    final fit = points.length == 1
        ? null
        : CameraFit.coordinates(coordinates: points, padding: const EdgeInsets.all(36), maxZoom: 16);
    return ClipRRect(
      borderRadius: BorderRadius.circular(radiusBlock),
      child: SizedBox(
        height: height,
        child: DecoratedBox(
          decoration: BoxDecoration(color: c.surface2),
          child: FlutterMap(
            options: MapOptions(
              initialCenter: points.first,
              initialZoom: 15,
              initialCameraFit: fit,
              interactionOptions: const InteractionOptions(flags: InteractiveFlag.all & ~InteractiveFlag.rotate),
            ),
            children: [
              if (tiles) osmTiles(),
              if (shop != null && drop != null)
                PolylineLayer(polylines: [
                  Polyline(
                    points: [shop!, drop!],
                    color: c.accent.withValues(alpha: .55),
                    strokeWidth: 3,
                    pattern: StrokePattern.dashed(segments: const [10, 8]),
                  ),
                ]),
              MarkerLayer(markers: [
                if (shop != null)
                  Marker(
                    point: shop!,
                    width: 34,
                    height: 34,
                    child: MapPin(icon: Icons.storefront_rounded, color: c.accent, fg: c.onAccent, label: 'Shop'),
                  ),
                if (drop != null)
                  Marker(
                    point: drop!,
                    width: 34,
                    height: 34,
                    child: MapPin(icon: Icons.home_rounded, color: c.ink, fg: c.surface, label: 'Customer'),
                  ),
                if (rider != null)
                  Marker(
                    point: rider!,
                    width: 34,
                    height: 34,
                    child: MapPin(
                      icon: Icons.two_wheeler,
                      color: riderStale ? c.muted : c.green,
                      fg: Colors.white,
                      label: riderStale ? 'Rider, location out of date' : 'Rider',
                    ),
                  ),
              ]),
            ],
          ),
        ),
      ),
    );
  }
}
