import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart';

import '../../../theme/app_theme.dart';
import '../../orders/order_mini_map.dart';

/// Bemetara town centre — where the map opens before anything is pinned.
const _fallbackCentre = LatLng(21.7152, 81.5339);

/// Tap the map to put the shop's pin there (§4.2). Approval needs a pin.
class MapPinPicker extends ConsumerStatefulWidget {
  const MapPinPicker({super.key, required this.pin, required this.onPin, this.height = 240});
  final LatLng? pin;
  final ValueChanged<LatLng> onPin;
  final double height;

  @override
  ConsumerState<MapPinPicker> createState() => _MapPinPickerState();
}

class _MapPinPickerState extends ConsumerState<MapPinPicker> {
  final _map = MapController();

  @override
  void didUpdateWidget(MapPinPicker old) {
    super.didUpdateWidget(old);
    final p = widget.pin;
    if (p != null && p != old.pin) {
      try {
        _map.move(p, 17);
      } catch (_) {
        // Not laid out yet; the initial centre takes it.
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final tiles = ref.watch(mapTilesEnabledProvider);
    return ClipRRect(
      borderRadius: BorderRadius.circular(radiusBlock),
      child: SizedBox(
        height: widget.height,
        child: FlutterMap(
          mapController: _map,
          options: MapOptions(
            initialCenter: widget.pin ?? _fallbackCentre,
            initialZoom: widget.pin == null ? 14 : 17,
            onTap: (_, at) => widget.onPin(at),
          ),
          children: [
            if (tiles) osmTiles() else ColoredBox(color: c.surface2),
            if (widget.pin != null)
              MarkerLayer(markers: [
                Marker(
                  point: widget.pin!,
                  width: 36,
                  height: 36,
                  child: MapPin(icon: Icons.storefront, color: c.accent, fg: c.onAccent, label: 'Shop'),
                ),
              ]),
          ],
        ),
      ),
    );
  }
}
