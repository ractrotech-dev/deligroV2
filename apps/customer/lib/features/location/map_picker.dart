import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

import '../../state/location.dart';
import '../../theme/app_theme.dart';

/// A spot the customer confirmed on the map, with whatever the reverse
/// geocoder could say about it (all three texts may be null).
class PickedPin {
  const PickedPin({required this.lat, required this.lng, this.label, this.sublabel, this.line});
  final double lat;
  final double lng;

  /// Short area name ("Station Road").
  final String? label;
  final String? sublabel;

  /// The full geocoded line, for prefilling an address.
  final String? line;
}

/// Full-screen pin picker. The pin stays in the middle and the map moves
/// under it, which is easier to aim with a thumb than dragging a marker.
Future<PickedPin?> showMapPicker(BuildContext context, {double? lat, double? lng}) =>
    Navigator.of(context, rootNavigator: true).push<PickedPin>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => _MapPickerPage(lat: lat, lng: lng),
      ),
    );

typedef _Place = ({String label, String? sublabel, String line});

class _MapPickerPage extends ConsumerStatefulWidget {
  const _MapPickerPage({this.lat, this.lng});
  final double? lat;
  final double? lng;

  @override
  ConsumerState<_MapPickerPage> createState() => _MapPickerPageState();
}

class _MapPickerPageState extends ConsumerState<_MapPickerPage> {
  final _map = MapController();
  late LatLng _center;
  Timer? _debounce;
  Timer? _settle;

  /// Bumped per lookup so a slow answer for an old spot can't overwrite a
  /// newer one.
  int _seq = 0;
  _Place? _place;
  LatLng? _placeFor;
  bool _looking = false;
  bool _moving = false;
  bool _locating = false;
  bool _confirming = false;

  @override
  void initState() {
    super.initState();
    if (widget.lat != null && widget.lng != null) {
      _center = LatLng(widget.lat!, widget.lng!);
    } else {
      final loc = ref.read(locationProvider);
      _center = LatLng(loc.lat, loc.lng);
    }
    _looking = true;
    _lookup(_center, immediate: true);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _settle?.cancel();
    _map.dispose();
    super.dispose();
  }

  void _onMoved(MapCamera camera, bool hasGesture) {
    _center = camera.center;
    if (!_moving) _safeSetState(() => _moving = true);
    _settle?.cancel();
    _settle = Timer(const Duration(milliseconds: 220), () => _safeSetState(() => _moving = false));
    _lookup(_center);
  }

  /// Debounced: Nominatim asks for at most one request a second.
  void _lookup(LatLng at, {bool immediate = false}) {
    _debounce?.cancel();
    final seq = ++_seq;
    if (!_looking) _safeSetState(() => _looking = true);
    _debounce = Timer(immediate ? Duration.zero : const Duration(milliseconds: 900), () async {
      final place = await reverseGeocode(at.latitude, at.longitude);
      if (!mounted || seq != _seq) return;
      setState(() {
        _place = place;
        _placeFor = at;
        _looking = false;
      });
    });
  }

  /// The map can report a camera change while it is laying out; defer the
  /// rebuild to after the frame in that case.
  void _safeSetState(VoidCallback fn) {
    if (!mounted) return;
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(fn);
      });
    } else {
      setState(fn);
    }
  }

  Future<void> _useMyLocation() async {
    setState(() => _locating = true);
    final fix = await currentPosition();
    if (!mounted) return;
    setState(() => _locating = false);
    final p = fix.position;
    if (fix.result == LocateResult.ok && p != null) {
      final at = LatLng(p.latitude, p.longitude);
      _map.move(at, 17);
      _center = at;
      _lookup(at, immediate: true);
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    messenger.hideCurrentSnackBar();
    messenger.showSnackBar(SnackBar(
      content: Text(switch (fix.result) {
        LocateResult.serviceOff => 'Your phone\'s location is turned off.',
        LocateResult.denied => 'Location permission was not given.',
        LocateResult.deniedForever => 'Location is blocked for Deligro. Allow it in settings.',
        _ => 'Couldn\'t find you. Move the map to your spot instead.',
      }),
      action: switch (fix.result) {
        LocateResult.serviceOff => SnackBarAction(
            label: 'Turn on',
            onPressed: () => Geolocator.openLocationSettings(),
          ),
        LocateResult.deniedForever => SnackBarAction(
            label: 'Settings',
            onPressed: () => Geolocator.openAppSettings(),
          ),
        _ => null,
      },
    ));
  }

  Future<void> _confirm() async {
    if (_confirming) return;
    final at = _center;
    var place = _placeFor == at ? _place : null;
    if (place == null) {
      // The lookup for this exact spot hasn't landed yet; one direct try so
      // the address isn't left nameless.
      setState(() => _confirming = true);
      _debounce?.cancel();
      _seq++;
      place = await reverseGeocode(at.latitude, at.longitude);
      if (!mounted) return;
    }
    Navigator.of(context).pop(PickedPin(
      lat: at.latitude,
      lng: at.longitude,
      label: place?.label,
      sublabel: place?.sublabel,
      line: place?.line.isEmpty ?? true ? null : place!.line,
    ));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final current = _placeFor == _center ? _place : null;
    return Scaffold(
      body: Stack(
        children: [
          Positioned.fill(
            child: FlutterMap(
              mapController: _map,
              options: MapOptions(
                initialCenter: _center,
                initialZoom: 16,
                minZoom: 5,
                maxZoom: 19,
                backgroundColor: c.surface2,
                interactionOptions: const InteractionOptions(
                  flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
                ),
                onPositionChanged: _onMoved,
              ),
              children: [
                TileLayer(
                  urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                  userAgentPackageName: 'com.ractrotech.deligro',
                  maxNativeZoom: 19,
                ),
              ],
            ),
          ),
          // The fixed centre pin: its tip sits on the map centre, and it lifts
          // a little while the map is moving.
          IgnorePointer(
            child: Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  AnimatedSlide(
                    duration: const Duration(milliseconds: 160),
                    offset: _moving ? const Offset(0, -0.18) : Offset.zero,
                    child: Icon(Icons.location_on_rounded, size: 48, color: c.accent, shadows: const [
                      Shadow(color: Color(0x55000000), blurRadius: 8, offset: Offset(0, 3)),
                    ]),
                  ),
                  Container(
                    width: _moving ? 6 : 10,
                    height: 4,
                    decoration: BoxDecoration(
                      color: const Color(0x55000000),
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                  const SizedBox(height: 50),
                ],
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  _RoundButton(
                    icon: Icons.close_rounded,
                    label: 'Close map',
                    onTap: () => Navigator.of(context).pop(),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      decoration: BoxDecoration(
                        color: c.surface,
                        borderRadius: BorderRadius.circular(999),
                        boxShadow: const [BoxShadow(color: Color(0x22000000), blurRadius: 10)],
                      ),
                      child: Text(
                        'Move the map to put the pin on your door',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.ink),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: c.surface.withValues(alpha: .85),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: Text('© OpenStreetMap contributors',
                            style: TextStyle(fontSize: 10.5, color: c.muted)),
                      ),
                      const Spacer(),
                      FloatingActionButton.extended(
                        heroTag: null,
                        onPressed: _locating ? null : _useMyLocation,
                        backgroundColor: c.surface,
                        foregroundColor: c.accentInk,
                        elevation: 3,
                        icon: _locating
                            ? SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(strokeWidth: 2, color: c.accentInk),
                              )
                            : const Icon(Icons.my_location_rounded),
                        label: Text(_locating ? 'Locating…' : 'Use my location',
                            style: const TextStyle(fontWeight: FontWeight.w800)),
                      ),
                    ],
                  ),
                ),
                Material(
                  color: c.surface,
                  elevation: 8,
                  shape: const RoundedRectangleBorder(
                    borderRadius: BorderRadius.vertical(top: Radius.circular(radiusSheet)),
                  ),
                  child: SafeArea(
                    top: false,
                    minimum: const EdgeInsets.fromLTRB(16, 18, 16, 14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text('DELIVER TO THIS PIN', style: Theme.of(context).textTheme.labelSmall),
                        const SizedBox(height: 8),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Container(
                              width: 40,
                              height: 40,
                              decoration: BoxDecoration(
                                color: c.accentSoft,
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Icon(Icons.place_rounded, color: c.accentInk),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: _looking && current == null
                                  ? const _PlaceSkeleton()
                                  : Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          current?.label ?? 'Pinned location',
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
                                        ),
                                        const SizedBox(height: 2),
                                        Text(
                                          current?.line.isNotEmpty == true
                                              ? current!.line
                                              : (current?.sublabel ??
                                                  'We couldn\'t name this spot, but the pin is what the courier follows.'),
                                          maxLines: 2,
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(fontSize: 13, color: c.muted, height: 1.3),
                                        ),
                                      ],
                                    ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: _confirming ? null : _confirm,
                          child: _confirming
                              ? SizedBox(
                                  width: 22,
                                  height: 22,
                                  child: CircularProgressIndicator(strokeWidth: 2.4, color: c.muted),
                                )
                              : const Text('Confirm location'),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _PlaceSkeleton extends StatelessWidget {
  const _PlaceSkeleton();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget bar(double w, double h) => Container(
          width: w,
          height: h,
          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(6)),
        );
    return Semantics(
      label: 'Finding the address',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [bar(150, 16), const SizedBox(height: 8), bar(230, 12)],
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      button: true,
      label: label,
      child: Material(
        color: c.surface,
        shape: const CircleBorder(),
        elevation: 3,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(width: 46, height: 46, child: Icon(icon, color: c.ink)),
        ),
      ),
    );
  }
}
