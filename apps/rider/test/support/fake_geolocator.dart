import 'dart:async';

import 'package:geolocator/geolocator.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

/// A geolocator that never touches a phone. Install with
/// `GeolocatorPlatform.instance = FakeGeolocator()`.
class FakeGeolocator extends GeolocatorPlatform
    with MockPlatformInterfaceMixin {
  FakeGeolocator({
    this.permission = LocationPermission.whileInUse,
    this.serviceEnabled = true,
  });

  LocationPermission permission;

  /// What a tap on the system prompt answers.
  LocationPermission? grantsOnRequest;
  bool serviceEnabled;

  int permissionRequests = 0;
  int streamsOpened = 0;
  int streamsCancelled = 0;
  int currentPositionCalls = 0;
  int appSettingsOpened = 0;
  int locationSettingsOpened = 0;

  /// The settings the last stream was opened with.
  LocationSettings? lastSettings;

  /// What [getCurrentPosition] answers (the heartbeat); null throws.
  Position? current;

  /// When set, [getCurrentPosition] waits for it (a slow reading).
  Completer<Position>? currentCompleter;

  StreamController<Position>? _controller;
  bool get streaming => _controller != null && _controller!.hasListener;

  void emit(Position p) => _controller!.add(p);

  void emitError(Object e) => _controller!.addError(e);

  @override
  Future<LocationPermission> checkPermission() async => permission;

  @override
  Future<LocationPermission> requestPermission() async {
    permissionRequests++;
    permission = grantsOnRequest ?? permission;
    return permission;
  }

  @override
  Future<bool> isLocationServiceEnabled() async => serviceEnabled;

  @override
  Future<Position> getCurrentPosition({
    LocationSettings? locationSettings,
  }) async {
    currentPositionCalls++;
    final waiting = currentCompleter;
    if (waiting != null) return waiting.future;
    final p = current;
    if (p == null) throw const LocationServiceDisabledException();
    return p;
  }

  @override
  Stream<Position> getPositionStream({LocationSettings? locationSettings}) {
    streamsOpened++;
    lastSettings = locationSettings;
    final c = StreamController<Position>(
      onCancel: () {
        streamsCancelled++;
        _controller = null;
      },
    );
    _controller = c;
    return c.stream;
  }

  @override
  Future<bool> openAppSettings() async {
    appSettingsOpened++;
    return true;
  }

  @override
  Future<bool> openLocationSettings() async {
    locationSettingsOpened++;
    return true;
  }
}

Position fix(double lat, double lng, {DateTime? at}) => Position(
  latitude: lat,
  longitude: lng,
  timestamp: at ?? DateTime(2026, 10, 21),
  accuracy: 5,
  altitude: 0,
  altitudeAccuracy: 0,
  heading: 0,
  headingAccuracy: 0,
  speed: 0,
  speedAccuracy: 0,
);
