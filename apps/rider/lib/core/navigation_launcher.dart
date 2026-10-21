import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/jobs.dart';

/// The app a rider navigates with (Settings, prefs `nav_app`).
enum NavApp {
  /// Google Maps turn-by-turn, or its web directions without the app.
  google,

  /// Whatever app the phone offers for a `geo:` link.
  other;

  static NavApp parse(String? v) => v == 'other' ? other : google;
}

/// Opens a link in another app; true when something took it. Tests replace it.
typedef UrlOpener = Future<bool> Function(Uri uri);

Future<bool> _launch(Uri uri) async {
  try {
    return await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    return false; // no app for this scheme
  }
}

final urlOpenerProvider = Provider<UrlOpener>((_) => _launch);

String _coords(LatLngPoint p) => '${p.lat},${p.lng}';

/// The links to try, in order, to navigate to a stop: by its point when it
/// has one, else by its address text. Each list ends with Google's web
/// directions, which any phone with a browser can open.
List<Uri> navigationUris(NavApp app, {LatLngPoint? point, String? address}) {
  final q = point != null ? _coords(point) : Uri.encodeComponent((address ?? '').trim());
  final web = Uri.parse('https://www.google.com/maps/dir/?api=1&destination=$q');
  return switch (app) {
    NavApp.google => [Uri.parse('google.navigation:q=$q&mode=d'), web],
    NavApp.other => [Uri.parse(point != null ? 'geo:$q?q=$q' : 'geo:0,0?q=$q'), web],
  };
}

/// Tries [navigationUris] until one opens. False when the stop has neither a
/// point nor an address, or nothing on the phone could open any of them.
Future<bool> navigateTo(UrlOpener open, NavApp app, RiderStop stop) async {
  final address = [stop.name, stop.line].where((s) => (s ?? '').trim().isNotEmpty).join(', ');
  if (stop.point == null && address.isEmpty) return false;
  for (final uri in navigationUris(app, point: stop.point, address: address)) {
    if (await open(uri)) return true;
  }
  return false;
}

/// `tel:` for a number the board sent, or null when there is none.
Uri? callUri(String? phone) {
  final digits = (phone ?? '').replaceAll(RegExp(r'[^0-9+]'), '');
  return digits.isEmpty ? null : Uri(scheme: 'tel', path: digits);
}
