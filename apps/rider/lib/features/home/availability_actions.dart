import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/location_service.dart';
import '../../state/availability.dart';
import '../../state/providers.dart';
import '../onboarding/location_disclosure_screen.dart';

/// Going online and offline, for any screen that shows the switch (Home's
/// availability card, and the Jobs tab when the rider is offline). One place
/// owns the sequence, so the two switches cannot drift apart.
mixin AvailabilityActions<T extends ConsumerStatefulWidget> on ConsumerState<T> {
  /// An action is on its way; the switch shows a spinner and ignores taps.
  bool busy = false;

  Future<void> run(Future<void> Function() action) async {
    if (busy) return;
    setState(() => busy = true);
    try {
      await action();
    } catch (e) {
      if (mounted) showAvailabilityError(e);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void showAvailabilityError(Object e) {
    final String text;
    if (e is ApiException && e.code == 'active_delivery') {
      text = 'Finish or hand back your current order first.';
    } else if (e is ApiException && (e.status == 503 || e.code == 'migration_pending')) {
      text = "Online status isn't available yet — Deligro is updating.";
    } else if (e is ApiException) {
      text = e.friendly;
    } else {
      text = 'Something went wrong. Please try again.';
    }
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  /// Going online needs the phone ready first: the disclosure read, location
  /// allowed and switched on. Only then does the website hear "online", and
  /// only when it has does the foreground service start.
  Future<void> goOnline() async {
    final location = ref.read(locationServiceProvider);
    final notifier = ref.read(availabilityProvider.notifier);
    location.report(null);

    var gate = await location.check();
    if (gate == LocationGate.needsDisclosure) {
      if (!mounted) return;
      final accepted = await context.push<bool>(locationDisclosurePath);
      if (accepted != true || !mounted) return;
      gate = await location.check();
    }
    if (!mounted) return;
    if (gate != LocationGate.ok) {
      location.report(gate);
      return;
    }

    await notifier.goOnline();
    if (!mounted) return; // the service provider starts it for an online rider
    final onDelivery = ref.read(meProvider).value?.activeDeliveryId != null;
    await location.start(activeDelivery: onDelivery);
  }

  Future<void> goOffline() async {
    final location = ref.read(locationServiceProvider);
    await ref.read(availabilityProvider.notifier).goOffline();
    await location.stop();
  }
}
