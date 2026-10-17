import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/address.dart';
import '../../state/location.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import 'address_form.dart';
import 'map_picker.dart';

/// Where the header's location chip leads (app/(customer)/location/page.tsx):
/// the device fix, a pin on the map, or a saved address. Pops once chosen.
class LocationScreen extends ConsumerStatefulWidget {
  const LocationScreen({super.key});

  @override
  ConsumerState<LocationScreen> createState() => _LocationScreenState();
}

class _LocationScreenState extends ConsumerState<LocationScreen> {
  bool _detecting = false;
  LocateResult? _failure;
  String? _busyId;

  void _leave() {
    if (context.canPop()) {
      context.pop();
    } else {
      context.go('/');
    }
  }

  Future<void> _detect() async {
    setState(() {
      _detecting = true;
      _failure = null;
    });
    final r = await ref.read(locationProvider.notifier).detect();
    if (!mounted) return;
    setState(() => _detecting = false);
    if (r == LocateResult.ok) {
      _leave();
    } else {
      setState(() => _failure = r);
    }
  }

  Future<void> _pickOnMap() async {
    final loc = ref.read(locationProvider);
    final pin = await showMapPicker(context, lat: loc.lat, lng: loc.lng);
    if (pin == null || !mounted) return;
    ref.read(locationProvider.notifier).set(DeliveryLocation(
          lat: pin.lat,
          lng: pin.lng,
          label: pin.label ?? 'Pinned location',
          sublabel: pin.sublabel,
        ));
    _leave();
  }

  void _adopt(SavedAddress a, {double? lat, double? lng}) {
    ref.read(locationProvider.notifier).set(DeliveryLocation(
          lat: lat ?? a.lat!,
          lng: lng ?? a.lng!,
          label: a.label,
          sublabel: addressLocality(a.line) ?? a.line,
          addressId: a.id,
        ));
    _leave();
  }

  Future<void> _chooseSaved(SavedAddress a) async {
    if (a.pinned) {
      _adopt(a);
      return;
    }
    // Without coordinates the shops can't be measured from it, so ask for a
    // pin rather than silently keeping the old location.
    final pinIt = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Put this address on the map?'),
        content: Text(
          '“${a.label}” has no pin yet, so we can\'t tell which shops deliver there. '
          'Drop a pin once and it\'s saved for next time.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Not now')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Pin on map')),
        ],
      ),
    );
    if (pinIt != true || !mounted) return;
    final loc = ref.read(locationProvider);
    final pin = await showMapPicker(context, lat: loc.lat, lng: loc.lng);
    if (pin == null || !mounted) return;
    setState(() => _busyId = a.id);
    try {
      await ref.read(addressesProvider.notifier).updatePin(a.id, pin.lat, pin.lng);
      if (!mounted) return;
      _adopt(a, lat: pin.lat, lng: pin.lng);
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.friendly);
    } catch (_) {
      if (mounted) showSnack(context, 'Could not save the pin. Try again.');
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _add() async {
    final saved = await showAddAddressSheet(context, ref);
    if (saved == null || !mounted) return;
    if (saved.pinned) {
      _adopt(saved);
    } else {
      showSnack(context, 'Address saved. Pin it on the map to deliver there.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final loc = ref.watch(locationProvider);
    final signedIn = ref.watch(userIdProvider) != null;
    final addresses = ref.watch(addressesProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Delivery location')),
      body: RefreshIndicator(
        onRefresh: () => refreshAll(ref, [addressesProvider]),
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
          children: [
            _CurrentCard(loc: loc),
            const SizedBox(height: 14),
            Panel(
              padding: EdgeInsets.zero,
              child: Column(
                children: [
                  _ActionTile(
                    icon: Icons.near_me_rounded,
                    emphasis: true,
                    busy: _detecting,
                    title: _detecting ? 'Locating…' : 'Use my current location',
                    subtitle: 'Detected from your phone',
                    onTap: _detecting ? null : _detect,
                  ),
                  Divider(height: 1, indent: 68, color: c.line),
                  _ActionTile(
                    icon: Icons.map_outlined,
                    title: 'Pick on map',
                    subtitle: 'Move the map to your door',
                    onTap: _pickOnMap,
                  ),
                  if (signedIn) ...[
                    Divider(height: 1, indent: 68, color: c.line),
                    _ActionTile(
                      icon: Icons.add_rounded,
                      title: 'Add a new address',
                      subtitle: 'Save it for next time',
                      onTap: _add,
                    ),
                  ],
                ],
              ),
            ),
            if (_failure != null && !_detecting) ...[
              const SizedBox(height: 12),
              _FailureCard(result: _failure!, onRetry: _detect),
            ],
            if (signedIn) ...[
              const SectionTitle('Saved addresses', padding: EdgeInsets.fromLTRB(2, 26, 2, 10)),
              addresses.when(
                skipLoadingOnRefresh: true,
                skipLoadingOnReload: true,
                loading: () => const _ListSkeleton(),
                error: (e, _) => ErrorRetry(error: e, onRetry: () => ref.invalidate(addressesProvider)),
                data: (list) => list.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Text(
                          'Nothing saved yet. Add an address and it\'ll show up here.',
                          style: TextStyle(color: c.muted),
                        ),
                      )
                    : Panel(
                        padding: EdgeInsets.zero,
                        child: Column(
                          children: [
                            for (var i = 0; i < list.length; i++) ...[
                              if (i > 0) Divider(height: 1, indent: 68, color: c.line),
                              _SavedTile(
                                address: list[i],
                                selected: list[i].id == loc.addressId,
                                busy: _busyId == list[i].id,
                                onTap: _busyId == null ? () => _chooseSaved(list[i]) : null,
                              ),
                            ],
                          ],
                        ),
                      ),
              ),
            ] else ...[
              const SizedBox(height: 22),
              Panel(
                child: Row(
                  children: [
                    Icon(Icons.bookmark_border_rounded, color: c.muted),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text('Sign in to use your saved addresses.',
                          style: TextStyle(color: c.muted)),
                    ),
                    TextButton(
                      onPressed: () => context.push('/login?next=/location'),
                      child: const Text('Sign in'),
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _CurrentCard extends StatelessWidget {
  const _CurrentCard({required this.loc});
  final DeliveryLocation loc;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.accentSoft,
        borderRadius: BorderRadius.circular(radiusBlock),
      ),
      child: Row(
        children: [
          Icon(Icons.location_on_rounded, color: c.accentInk),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(loc.isFallback ? 'NO LOCATION SET YET' : 'DELIVERING TO',
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(color: c.accentInk)),
                const SizedBox(height: 2),
                Text(
                  loc.isFallback ? 'Showing shops around ${loc.label}' : loc.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: c.ink),
                ),
                if (!loc.isFallback && loc.sublabel != null)
                  Text(loc.sublabel!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, color: c.muted)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ActionTile extends StatelessWidget {
  const _ActionTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.emphasis = false,
    this.busy = false,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback? onTap;
  final bool emphasis;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(radiusBlock),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: emphasis ? c.accentSoft : c.surface2,
                borderRadius: BorderRadius.circular(12),
              ),
              child: busy
                  ? Padding(
                      padding: const EdgeInsets.all(11),
                      child: CircularProgressIndicator(strokeWidth: 2, color: c.accentInk),
                    )
                  : Icon(icon, size: 21, color: emphasis ? c.accentInk : c.ink),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: TextStyle(
                        fontWeight: FontWeight.w800,
                        fontSize: 15,
                        color: emphasis ? c.accentInk : c.ink,
                      )),
                  Text(subtitle, style: TextStyle(fontSize: 13, color: c.muted)),
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, color: c.muted),
          ],
        ),
      ),
    );
  }
}

class _FailureCard extends StatelessWidget {
  const _FailureCard({required this.result, required this.onRetry});
  final LocateResult result;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (String message, String action, VoidCallback onAction) = switch (result) {
      LocateResult.serviceOff => (
          'Your phone\'s location (GPS) is turned off. Turn it on, then try again.',
          'Turn on location',
          () => Geolocator.openLocationSettings(),
        ),
      LocateResult.deniedForever => (
          'Location is blocked for Deligro. Allow it in the app settings under Permissions → Location.',
          'Open app settings',
          () => Geolocator.openAppSettings(),
        ),
      LocateResult.denied => (
          'Deligro needs location permission to find you. You can also pick your spot on the map.',
          'Try again',
          onRetry,
        ),
      _ => (
          'We couldn\'t get a fix on your location. Try again, or pick your spot on the map.',
          'Try again',
          onRetry,
        ),
    };
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.dealSoft,
        borderRadius: BorderRadius.circular(radiusBlock),
      ),
      child: Semantics(
        liveRegion: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.location_off_rounded, size: 20, color: c.deal),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(message,
                      style: TextStyle(color: c.ink, fontWeight: FontWeight.w600, height: 1.35)),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                OutlinedButton(onPressed: onAction, child: Text(action)),
                if (result == LocateResult.serviceOff || result == LocateResult.deniedForever) ...[
                  const SizedBox(width: 8),
                  TextButton(onPressed: onRetry, child: const Text('Try again')),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SavedTile extends StatelessWidget {
  const _SavedTile({
    required this.address,
    required this.selected,
    required this.busy,
    required this.onTap,
  });

  final SavedAddress address;
  final bool selected;
  final bool busy;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final a = address;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 40,
              height: 40,
              decoration: BoxDecoration(
                color: selected ? c.accent : c.surface2,
                borderRadius: BorderRadius.circular(12),
              ),
              child: busy
                  ? Padding(
                      padding: const EdgeInsets.all(11),
                      child: CircularProgressIndicator(strokeWidth: 2, color: c.muted),
                    )
                  : Icon(_iconFor(a.label), size: 21, color: selected ? c.onAccent : c.muted),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(a.label, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                      if (a.isDefault) _Tag('Default', bg: c.surface2, fg: c.muted),
                      if (!a.pinned) _Tag('Not on map', bg: c.dealSoft, fg: c.deal),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(a.line, style: TextStyle(fontSize: 13, color: c.muted, height: 1.3)),
                ],
              ),
            ),
            if (selected) ...[
              const SizedBox(width: 8),
              Icon(Icons.check_circle_rounded, color: c.accent, semanticLabel: 'Selected'),
            ],
          ],
        ),
      ),
    );
  }
}

IconData _iconFor(String label) => switch (label.toLowerCase()) {
      'home' => Icons.home_rounded,
      'work' => Icons.work_rounded,
      _ => Icons.location_on_rounded,
    };

class _Tag extends StatelessWidget {
  const _Tag(this.text, {required this.bg, required this.fg});
  final String text;
  final Color bg;
  final Color fg;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
        child: Text(text.toUpperCase(),
            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: .5, color: fg)),
      );
}

class _ListSkeleton extends StatelessWidget {
  const _ListSkeleton();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      children: [
        for (var i = 0; i < 2; i++)
          Container(
            height: 66,
            margin: const EdgeInsets.only(bottom: 10),
            decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
          ),
      ],
    );
  }
}
