import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:latlong2/latlong.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/order.dart';
import '../../models/tracking.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/cart_widgets.dart';
import '../../widgets/common.dart';
import 'orders_screen.dart';

/// Past this, a countdown is fiction (CUSTOMER_LATE_CAP_MINUTES on the web).
const _lateCapMinutes = 180;

/// Live order tracking (components/orders/tracking-view.tsx +
/// hooks/use-live-tracking.ts): map, ETA, stages, courier,
/// bill and what's left to do with the order.
class TrackingScreen extends ConsumerStatefulWidget {
  const TrackingScreen({super.key, required this.orderId, this.justPlaced = false});
  final String orderId;
  final bool justPlaced;

  @override
  ConsumerState<TrackingScreen> createState() => _TrackingScreenState();
}

class _TrackingScreenState extends ConsumerState<TrackingScreen> {
  static const _pollEvery = Duration(seconds: 3);

  Timer? _timer;
  bool _disposed = false;
  TrackingSnapshot? _snap;
  int _failures = 0;
  bool _signedOut = false;
  bool _pollingDone = false;
  bool _ticking = false;

  bool _cancelBusy = false;
  String? _cancelMsg;

  @override
  void initState() {
    super.initState();
    _tick();
    if (widget.justPlaced) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) showSnack(context, 'Order placed');
      });
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    super.dispose();
  }

  /// One request at a time: the next poll is scheduled only after this one
  /// lands, so a slow network never stacks requests.
  Future<void> _tick() async {
    if (_ticking) return;
    _ticking = true;
    _timer?.cancel();
    var again = false;
    try {
      again = await _pollOnce();
    } finally {
      _ticking = false;
    }
    if (again && !_disposed) _timer = Timer(_pollEvery, _tick);
  }

  /// Returns whether to keep polling.
  Future<bool> _pollOnce() async {
    try {
      final snap = await ref.read(orderRepoProvider).tracking(widget.orderId);
      if (_disposed) return false;
      final changed = _snap != null && _snap!.status != snap.status;
      setState(() {
        _snap = snap;
        _failures = 0;
        _signedOut = false;
        _pollingDone = !snap.status.inFlight;
      });
      if (changed) _onStatusChanged();
      return snap.status.inFlight;
    } on ApiException catch (e) {
      if (_disposed) return false;
      setState(() {
        _failures++;
        _signedOut = e.unauthorized;
      });
      return !(e.unauthorized || e.status == 404);
    } catch (_) {
      if (_disposed) return false;
      setState(() => _failures++);
      return true;
    }
  }

  void _onStatusChanged() {
    ref.invalidate(orderProvider(widget.orderId));
    ref.invalidate(activeOrderProvider);
    ref.invalidate(myOrdersProvider);
  }

  Future<void> _refresh() async {
    ref.invalidate(orderProvider(widget.orderId));
    _pollingDone = false;
    await _tick();
  }

  Future<void> _cancel(Order order) async {
    final paidOnline = order.paymentMethod == 'online' && order.paymentStatus == 'paid';
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Cancel order?'),
        content: Text(
          'Do you want to cancel your order? This can\'t be undone.'
          '${paidOnline ? '\n\nYou paid online, so a full refund will be queued to your original payment method.' : ''}',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('No')),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: ctx.colors.deal,
              foregroundColor: Colors.white,
              minimumSize: const Size(48, 44),
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Yes, cancel'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    setState(() {
      _cancelBusy = true;
      _cancelMsg = null;
    });
    try {
      final refundQueued = await ref.read(orderRepoProvider).cancel(order.id);
      if (!mounted) return;
      showSnack(
        context,
        refundQueued ? 'Order cancelled. Your refund has been queued.' : 'Order cancelled.',
      );
      _onStatusChanged();
      await _refresh();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _cancelMsg = e.code == 'too_late'
          ? 'The kitchen already started — can\'t cancel now.'
          : e.friendly);
      if (e.code == 'too_late') _refresh();
    } catch (_) {
      if (mounted) setState(() => _cancelMsg = 'Could not cancel. Try again.');
    } finally {
      if (mounted) setState(() => _cancelBusy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final async = ref.watch(orderProvider(widget.orderId));
    final order = async.value;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(order == null ? 'Order' : 'Order ${order.shortId}'),
            if (order != null)
              Text(order.restaurantName,
                  style: TextStyle(fontSize: 13, color: context.colors.muted, fontWeight: FontWeight.w500)),
          ],
        ),
      ),
      body: AsyncBody<Order?>(
        value: async,
        onRetry: () => ref.invalidate(orderProvider(widget.orderId)),
        loading: const _TrackingSkeleton(),
        builder: (order) => order == null
            ? EmptyState(
                icon: Icons.search_off_rounded,
                title: 'We couldn\'t find this order',
                action: 'Go to orders',
                onAction: () => context.go('/orders'),
              )
            : RefreshIndicator(onRefresh: _refresh, child: _body(context, order)),
      ),
    );
  }

  Widget _body(BuildContext context, Order order) {
    final c = context.colors;
    final snap = _snap;
    final status = snap?.status ?? order.status;
    final delivered = status == OrderStatus.delivered;
    final cancelled = status == OrderStatus.cancelled;
    final inFlight = status.inFlight;
    final rider = snap?.rider;
    final hasPoints = snap?.restaurant != null || snap?.destination != null;
    // Only while the order is still on the way: the flag can outlive the
    // status by one poll, and "arrived" over a delivered order would be stale.
    final riderArrived = snap?.riderArrived == true && status == OrderStatus.onTheWay;

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.only(bottom: 32),
      children: [
        if (hasPoints)
          _TrackingMap(snap: snap!, showRider: inFlight)
        else
          _TintHeader(order: order),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_failures >= 3 && !_pollingDone) _StaleNotice(signedOut: _signedOut),
              _EtaHeadline(order: order, snap: snap, status: status, riderArrived: riderArrived),
              if (inFlight && snap?.eta?.late == true) ...[
                const SizedBox(height: 12),
                _LateNotice(lateBy: snap!.eta!.lateByMinutes),
              ],
              if (inFlight && snap?.shopRunningLate == true) ...[
                const SizedBox(height: 12),
                const ShopDelayNotice(),
              ],
              if (inFlight && snap?.weather != null) ...[
                const SizedBox(height: 12),
                Text(
                  snap!.weather!,
                  key: const Key('tracking-weather'),
                  textAlign: TextAlign.center,
                  style: TextStyle(color: context.colors.muted, fontWeight: FontWeight.w600, fontSize: 13.5),
                ),
              ],
              const SizedBox(height: 18),
              if (inFlight) ...[
                Panel(
                  child: _Stepper(
                    current: status.step,
                    steps: trackingSteps(
                      restaurantName: order.restaurantName,
                      riderName: rider?.name,
                      riderArrived: riderArrived,
                    ),
                  ),
                ),
                const SizedBox(height: 14),
              ],
              if (cancelled) ...[
                _CancelledCard(order: order),
                const SizedBox(height: 14),
              ],
              if (delivered) ...[
                _RateCard(orderId: order.id),
                const SizedBox(height: 14),
                // The courier is rated apart from the food: one rating per
                // order, and the rider never sees who gave it.
                if (rider != null) ...[
                  RiderRateCard(orderId: order.id, riderName: rider.name),
                  const SizedBox(height: 14),
                ],
                _ProofOfDelivery(orderId: order.id),
              ],
              if (inFlight && snap?.riderPosition != null && snap?.riderPositionSource != 'gps') ...[
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(Icons.navigation_outlined, size: 16, color: c.muted),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          'The courier pin is an estimate along the route — this rider isn\'t sharing a live location.',
                          style: TextStyle(fontSize: 12.5, color: c.muted, height: 1.4),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),
              ],
              if (inFlight && rider != null) ...[
                _CourierCard(rider: rider),
                const SizedBox(height: 14),
              ],
              _BillCard(order: order, delivered: delivered),
              const SizedBox(height: 16),
              if (status.customerCanCancel) ...[
                OutlinedButton.icon(
                  onPressed: _cancelBusy ? null : () => _cancel(order),
                  style: OutlinedButton.styleFrom(foregroundColor: c.deal),
                  icon: _cancelBusy
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.cancel_outlined, size: 18),
                  label: const Text('Cancel order'),
                ),
                if (_cancelMsg != null)
                  Container(
                    margin: const EdgeInsets.only(top: 8),
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                    decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(12)),
                    child: Text(_cancelMsg!,
                        textAlign: TextAlign.center,
                        style: TextStyle(color: c.deal, fontSize: 13, fontWeight: FontWeight.w600)),
                  ),
                const SizedBox(height: 10),
              ],
              // As on the web: any delivered order, or a cancelled one that
              // was actually paid (an unpaid COD cancel has nothing to return).
              if (order.total > 0 && (delivered || (cancelled && order.paymentStatus == 'paid'))) ...[
                _RefundButton(order: order),
                const SizedBox(height: 10),
              ],
              OutlinedButton.icon(
                onPressed: () => context.push('/orders/${order.id}/receipt'),
                icon: const Icon(Icons.receipt_long_outlined, size: 18),
                label: const Text('View receipt'),
              ),
              const SizedBox(height: 10),
              OutlinedButton.icon(
                onPressed: () => context.push('/profile/help?order=${Uri.encodeComponent(order.id)}'),
                icon: const Icon(Icons.help_outline_rounded, size: 18),
                label: const Text('Get help with this order'),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Map / header
// ---------------------------------------------------------------------------

LatLng _ll(LatLngPoint p) => LatLng(p.lat, p.lng);

class _TrackingMap extends StatefulWidget {
  const _TrackingMap({required this.snap, required this.showRider});
  final TrackingSnapshot snap;
  final bool showRider;

  @override
  State<_TrackingMap> createState() => _TrackingMapState();
}

class _TrackingMapState extends State<_TrackingMap> {
  final _controller = MapController();
  int _fittedFor = -1;
  bool _ready = false;

  List<LatLng> _points() => [
        if (widget.snap.restaurant != null) _ll(widget.snap.restaurant!),
        if (widget.snap.destination != null) _ll(widget.snap.destination!),
        if (widget.showRider && widget.snap.riderPosition != null) _ll(widget.snap.riderPosition!),
      ];

  CameraFit _fit(List<LatLng> pts) => CameraFit.bounds(
        bounds: LatLngBounds.fromPoints(pts),
        padding: const EdgeInsets.fromLTRB(48, 56, 48, 40),
        maxZoom: 16,
      );

  /// Re-fit when a point appears (the rider usually turns up mid-order), but
  /// not on every poll — that would fight the customer's own panning.
  void _maybeRefit() {
    final pts = _points();
    if (!_ready || pts.length == _fittedFor || pts.isEmpty) return;
    _fittedFor = pts.length;
    try {
      _controller.fitCamera(_fit(pts));
    } catch (_) {
      // Controller not attached yet; the next poll retries.
    }
  }

  @override
  void didUpdateWidget(covariant _TrackingMap oldWidget) {
    super.didUpdateWidget(oldWidget);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _maybeRefit();
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final s = widget.snap;
    final pts = _points();
    final rider = widget.showRider ? s.riderPosition : null;

    return SizedBox(
      height: 260,
      child: FlutterMap(
        mapController: _controller,
        options: MapOptions(
          initialCenter: pts.first,
          initialZoom: 15,
          initialCameraFit: pts.length > 1 ? _fit(pts) : null,
          interactionOptions: const InteractionOptions(
            flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
          ),
          onMapReady: () {
            _ready = true;
            _fittedFor = pts.length;
          },
        ),
        children: [
          TileLayer(
            urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            userAgentPackageName: 'com.ractrotech.deligro',
          ),
          if (s.restaurant != null && s.destination != null)
            PolylineLayer(polylines: [
              Polyline(
                points: [_ll(s.restaurant!), _ll(s.destination!)],
                color: c.accent.withValues(alpha: .55),
                strokeWidth: 3,
                pattern: StrokePattern.dashed(segments: const [10, 8]),
              ),
            ]),
          MarkerLayer(markers: [
            if (s.restaurant != null)
              Marker(
                point: _ll(s.restaurant!),
                width: 40,
                height: 40,
                child: _Pin(icon: Icons.storefront_rounded, color: c.accent, fg: c.onAccent, label: 'Restaurant'),
              ),
            if (s.destination != null)
              Marker(
                point: _ll(s.destination!),
                width: 40,
                height: 40,
                child: _Pin(icon: Icons.home_rounded, color: c.ink, fg: c.bg, label: 'Your address'),
              ),
            if (rider != null)
              Marker(
                point: _ll(rider),
                width: 96,
                height: 64,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (s.riderPositionSource == 'estimated')
                      Container(
                        margin: const EdgeInsets.only(bottom: 2),
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(
                          color: c.surface,
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: c.line),
                        ),
                        child: Text('approximate',
                            style: TextStyle(fontSize: 10, fontWeight: FontWeight.w700, color: c.muted)),
                      ),
                    _Pin(icon: Icons.two_wheeler_rounded, color: c.green, fg: Colors.white, label: 'Rider'),
                  ],
                ),
              ),
          ]),
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

/// No coordinates to draw: the shop's tint instead of an empty map.
class _TintHeader extends StatelessWidget {
  const _TintHeader({required this.order});
  final Order order;

  @override
  Widget build(BuildContext context) => SizedBox(
        height: 140,
        child: Stack(
          fit: StackFit.expand,
          children: [
            NetImage(url: order.restaurantImage, tint: order.restaurantAccent, radius: 0),
            const DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [Color(0x10000000), Color(0x99000000)],
                ),
              ),
            ),
            Positioned(
              left: 16,
              right: 16,
              bottom: 14,
              child: Text(order.restaurantName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
            ),
          ],
        ),
      );
}

// ---------------------------------------------------------------------------
// Status blocks
// ---------------------------------------------------------------------------

class _StaleNotice extends StatelessWidget {
  const _StaleNotice({required this.signedOut});
  final bool signedOut;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      margin: const EdgeInsets.only(bottom: 14),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: c.dealSoft,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.deal.withValues(alpha: .3)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.wifi_off_rounded, size: 16, color: c.deal),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              signedOut
                  ? 'You\'ve been signed out, so this has stopped updating. Sign in again to see live progress.'
                  : 'Live updates paused, retrying… Showing the last status we received.',
              style: TextStyle(color: c.deal, fontSize: 12.5, fontWeight: FontWeight.w600, height: 1.4),
            ),
          ),
        ],
      ),
    );
  }
}

class _EtaHeadline extends StatelessWidget {
  const _EtaHeadline({
    required this.order,
    required this.snap,
    required this.status,
    this.riderArrived = false,
  });
  final Order order;
  final bool riderArrived;
  final TrackingSnapshot? snap;
  final OrderStatus status;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final eta = snap?.eta;
    final String caption;
    final String headline;
    String? sub;
    Color? tone;

    if (status == OrderStatus.delivered) {
      caption = 'Your order was delivered';
      headline = 'Delivered';
      tone = c.green;
    } else if (status == OrderStatus.cancelled) {
      caption = 'This order was cancelled';
      headline = 'Cancelled';
      tone = c.deal;
    } else if (riderArrived) {
      // No countdown is left to show: the rider is at the door.
      caption = 'Meet them at the door';
      headline = 'Your rider has arrived';
      tone = c.green;
    } else {
      caption = 'Estimated time of delivery';
      final mins = eta?.minutesRemaining;
      final by = eta?.expectedAt == null ? null : DateFormat('h:mm a').format(eta!.expectedAt!.toLocal());
      if (mins != null) {
        headline = mins > 0 ? 'Arriving in ~$mins min' : 'Arriving now';
        if (mins > 0 && by != null) sub = 'Expected by $by';
      } else if (by != null) {
        headline = 'Arriving by $by';
      } else if (order.etaMin != null) {
        headline = 'Arriving in ~${order.etaMin} min';
      } else {
        headline = 'On its way';
      }
    }

    return Semantics(
      liveRegion: true,
      child: Column(
        children: [
          Text(caption, style: TextStyle(color: c.muted, fontSize: 14)),
          const SizedBox(height: 4),
          Text(
            headline,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 30,
              fontWeight: FontWeight.w800,
              letterSpacing: -0.8,
              height: 1.1,
              color: tone ?? c.ink,
            ),
          ),
          if (sub != null) ...[
            const SizedBox(height: 4),
            Text(sub, style: TextStyle(color: c.muted, fontSize: 13, fontWeight: FontWeight.w600)),
          ],
          const SizedBox(height: 8),
          OrderStatusChip(status),
        ],
      ),
    );
  }
}

/// "The shop is running late" — the fixed sentence for a rider's shop-delay
/// report (ruling P7-R1). Never the report's text.
class ShopDelayNotice extends StatelessWidget {
  const ShopDelayNotice({super.key});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.storefront_rounded, size: 16, color: c.ink),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              kShopRunningLate,
              textAlign: TextAlign.center,
              style: TextStyle(color: c.ink, fontWeight: FontWeight.w700, fontSize: 13.5),
            ),
          ),
        ],
      ),
    );
  }
}

class _LateNotice extends StatelessWidget {
  const _LateNotice({required this.lateBy});
  final int lateBy;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(radiusBlock)),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.schedule_rounded, size: 16, color: c.deal),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              lateBy >= _lateCapMinutes
                  ? 'This order is delayed. Our team is on it — contact support if you need help.'
                  : 'Running about ${lateness(lateBy)}',
              textAlign: TextAlign.center,
              style: TextStyle(color: c.deal, fontWeight: FontWeight.w700, fontSize: 13.5),
            ),
          ),
        ],
      ),
    );
  }
}

class _Stepper extends StatelessWidget {
  const _Stepper({required this.current, required this.steps});
  final int current;
  final List<({String title, String sub})> steps;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      children: [
        for (var i = 0; i < steps.length; i++)
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Column(
                  children: [
                    Container(
                      width: 24,
                      height: 24,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: i < current ? c.green : c.surface,
                        border: Border.all(color: i <= current ? c.green : c.line, width: 2),
                      ),
                      alignment: Alignment.center,
                      child: i < current
                          ? const Icon(Icons.check_rounded, size: 15, color: Colors.white)
                          : i == current
                              ? Container(
                                  width: 10,
                                  height: 10,
                                  decoration: BoxDecoration(color: c.green, shape: BoxShape.circle),
                                )
                              : null,
                    ),
                    if (i < steps.length - 1)
                      Expanded(
                        child: Container(
                          width: 2,
                          margin: const EdgeInsets.symmetric(vertical: 4),
                          constraints: const BoxConstraints(minHeight: 22),
                          decoration: BoxDecoration(
                            color: i < current ? c.green : c.line,
                            borderRadius: BorderRadius.circular(2),
                          ),
                        ),
                      ),
                  ],
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.only(bottom: i == steps.length - 1 ? 0 : 18, top: 2),
                    child: Semantics(
                      label: '${steps[i].title}, ${i < current ? 'done' : i == current ? 'current' : 'to come'}',
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(steps[i].title,
                              style: TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w700,
                                color: i <= current ? c.ink : c.muted,
                              )),
                          const SizedBox(height: 2),
                          Text(steps[i].sub, style: TextStyle(fontSize: 12.5, color: c.muted)),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _CancelledCard extends StatelessWidget {
  const _CancelledCard({required this.order});
  final Order order;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final note = cancellationNote(order);
    final refundQueued = order.paymentMethod == 'online' && order.paymentStatus == 'paid';
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(note?.who ?? 'This order was cancelled',
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
          if (note?.reason != null) ...[
            const SizedBox(height: 4),
            Text('“${note!.reason}”', style: TextStyle(color: c.muted, fontSize: 14, height: 1.45)),
          ],
          if (refundQueued) ...[
            const SizedBox(height: 8),
            Text('You paid online — the money is still with us and will go back to how you paid.',
                style: TextStyle(color: c.muted, fontSize: 13, height: 1.4)),
          ],
          if (order.paymentStatus == 'refunded') ...[
            const SizedBox(height: 8),
            Text('Refunded to your original payment method.',
                style: TextStyle(color: c.green, fontSize: 13, fontWeight: FontWeight.w700)),
          ],
        ],
      ),
    );
  }
}

/// 1–5 stars with an optional comment.
/// "Proof of delivery" — the photo the rider took at the door, when there is
/// one. Asks `GET /api/orders/:id/proof` once and draws nothing unless it
/// answers with a link. The link lasts ten minutes, so a fresh one is fetched
/// on the tap instead of keeping the first. A photo deleted under the 90-day
/// retention rule reads "Photo removed after 90 days".
class _ProofOfDelivery extends ConsumerStatefulWidget {
  const _ProofOfDelivery({required this.orderId});
  final String orderId;

  @override
  ConsumerState<_ProofOfDelivery> createState() => _ProofOfDeliveryState();
}

class _ProofOfDeliveryState extends ConsumerState<_ProofOfDelivery> {
  bool _available = false;
  bool _removed = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    final proof = await ref.read(orderRepoProvider).proof(widget.orderId);
    if (!mounted) return;
    if (proof.url != null) {
      setState(() => _available = true);
    } else if (proof.removed) {
      setState(() => _removed = true);
    }
  }

  Future<void> _open() async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final url = await ref.read(orderRepoProvider).proofUrl(widget.orderId);
      if (!mounted) return;
      if (url == null) {
        showSnack(context, 'Could not open the photo. Try again.');
        return;
      }
      await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_available && _removed) {
      return Padding(
        key: const Key('proof-removed'),
        padding: const EdgeInsets.only(bottom: 14),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.photo_camera_outlined, size: 18, color: Theme.of(context).hintColor),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                'Photo removed after 90 days',
                style: TextStyle(color: Theme.of(context).hintColor, fontWeight: FontWeight.w600),
              ),
            ),
          ],
        ),
      );
    }
    if (!_available) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: OutlinedButton.icon(
        onPressed: _busy ? null : _open,
        icon: _busy
            ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
            : const Icon(Icons.photo_camera_outlined, size: 18),
        label: const Text('Proof of delivery'),
      ),
    );
  }
}

class _RateCard extends ConsumerStatefulWidget {
  const _RateCard({required this.orderId});
  final String orderId;

  @override
  ConsumerState<_RateCard> createState() => _RateCardState();
}

class _RateCardState extends ConsumerState<_RateCard> {
  final _comment = TextEditingController();
  int _rating = 0;
  bool _busy = false;
  bool _done = false;
  String? _note;

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_rating == 0 || _busy) return;
    setState(() {
      _busy = true;
      _note = null;
    });
    try {
      await ref.read(orderRepoProvider).review(widget.orderId, _rating, comment: _comment.text.trim());
      if (mounted) setState(() => _done = true);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        if (e.code == 'already_reviewed') {
          _done = true;
          _note = 'You have already rated this order.';
        } else {
          _note = e.friendly;
        }
      });
    } catch (_) {
      if (mounted) setState(() => _note = 'Couldn\'t send your rating. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(color: c.greenSoft, borderRadius: BorderRadius.circular(radiusBlock)),
      child: Column(
        children: [
          Text(
            _done ? (_note ?? 'Thanks for rating!') : 'Hope it was delicious. How was it?',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (var n = 1; n <= 5; n++)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 3),
                  child: Semantics(
                    button: true,
                    selected: n <= _rating,
                    label: 'Rate $n star${n > 1 ? 's' : ''}',
                    child: Material(
                      color: c.surface,
                      shape: const CircleBorder(),
                      child: InkWell(
                        customBorder: const CircleBorder(),
                        onTap: _done || _busy ? null : () => setState(() => _rating = n),
                        child: SizedBox(
                          width: 46,
                          height: 46,
                          child: Icon(
                            n <= _rating ? Icons.star_rounded : Icons.star_outline_rounded,
                            color: n <= _rating ? c.pop : c.muted,
                            size: 26,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          if (!_done && _rating > 0) ...[
            const SizedBox(height: 14),
            TextField(
              controller: _comment,
              maxLength: 500,
              minLines: 2,
              maxLines: 4,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(hintText: 'Anything to add? (optional)', counterText: ''),
            ),
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: _busy ? null : _submit,
                child: _busy
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Submit rating'),
              ),
            ),
          ],
          if (!_done && _note != null) ...[
            const SizedBox(height: 8),
            Text(_note!, style: TextStyle(color: c.deal, fontSize: 13, fontWeight: FontWeight.w600)),
          ],
        ],
      ),
    );
  }
}

/// "Rate (rider's first name)": 1–5 stars and an optional comment for the rider who
/// delivered this order, below the restaurant rating (the web's
/// `RiderRatingCard`). Asks `GET /api/orders/:id/rider-rating` once; when the
/// order already has a rating (an earlier visit, another device) it shows what
/// was given instead of the stars. Posts to `POST …/rider-rating`; the rider
/// and the customer are the server's to name.
class RiderRateCard extends ConsumerStatefulWidget {
  const RiderRateCard({super.key, required this.orderId, required this.riderName});
  final String orderId;
  final String riderName;

  @override
  ConsumerState<RiderRateCard> createState() => _RiderRateCardState();
}

class _RiderRateCardState extends ConsumerState<RiderRateCard> {
  static const _maxComment = 300;

  final _comment = TextEditingController();
  bool _loaded = false;
  ({int rating, String? comment})? _given;
  int _stars = 0;
  bool _busy = false;
  String? _error;

  /// "Ravi Kumar" → "Ravi"; null when the server only had a placeholder name.
  String? get _first {
    final name = widget.riderName.trim();
    if (name.isEmpty || name == 'Your courier' || name == 'Your rider') return null;
    return name.split(RegExp(r'\s+')).first;
  }

  String get _who => _first ?? 'your rider';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _comment.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final given = await ref.read(orderRepoProvider).riderRating(widget.orderId);
    if (!mounted) return;
    setState(() {
      _given = given;
      _loaded = true;
    });
  }

  Future<void> _submit() async {
    if (_stars == 0 || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final comment = _comment.text.trim();
    try {
      await ref.read(orderRepoProvider).rateRider(widget.orderId, _stars, comment: comment.isEmpty ? null : comment);
      if (mounted) setState(() => _given = (rating: _stars, comment: comment.isEmpty ? null : comment));
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.code == 'already_rated') {
        // Rated before: show what was given rather than a form that cannot work.
        final given = await ref.read(orderRepoProvider).riderRating(widget.orderId);
        if (!mounted) return;
        setState(() {
          _given = given;
          if (given == null) _error = e.friendly;
        });
      } else {
        setState(() => _error = e.friendly);
      }
    } catch (_) {
      if (mounted) setState(() => _error = 'Couldn\'t send your rating. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // Until we know whether this order was rated, draw nothing rather than a form that may not apply.
    if (!_loaded) return const SizedBox.shrink();
    final c = context.colors;
    final given = _given;
    if (given != null) {
      return Container(
        key: const Key('rider-rating-given'),
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
        child: Column(
          children: [
            Text('You rated $_who',
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            Semantics(
              label: '${given.rating} out of 5 stars',
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (var n = 1; n <= 5; n++)
                    Icon(
                      n <= given.rating ? Icons.star_rounded : Icons.star_outline_rounded,
                      color: n <= given.rating ? c.pop : c.muted,
                      size: 24,
                    ),
                ],
              ),
            ),
            if (given.comment != null) ...[
              const SizedBox(height: 8),
              Text('“${given.comment}”',
                  textAlign: TextAlign.center, style: TextStyle(color: c.muted, fontSize: 14, height: 1.4)),
            ],
            const SizedBox(height: 8),
            Text('Thank you for telling us.', style: TextStyle(color: c.muted, fontSize: 12.5)),
          ],
        ),
      );
    }
    return Container(
      key: const Key('rider-rating-form'),
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
      child: Column(
        children: [
          Text(_first == null ? 'Rate your rider' : 'Rate $_first',
              textAlign: TextAlign.center, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text('How was the delivery? Your rider won\'t see your name.',
              textAlign: TextAlign.center, style: TextStyle(color: c.muted, fontSize: 12.5, height: 1.4)),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              for (var n = 1; n <= 5; n++)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 3),
                  child: Semantics(
                    button: true,
                    selected: n <= _stars,
                    label: 'Rate $_who $n star${n > 1 ? 's' : ''}',
                    child: Material(
                      color: c.surface,
                      shape: const CircleBorder(),
                      child: InkWell(
                        key: Key('rider-star-$n'),
                        customBorder: const CircleBorder(),
                        onTap: _busy ? null : () => setState(() => _stars = n),
                        child: SizedBox(
                          width: 46,
                          height: 46,
                          child: Icon(
                            n <= _stars ? Icons.star_rounded : Icons.star_outline_rounded,
                            color: n <= _stars ? c.pop : c.muted,
                            size: 26,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          if (_stars > 0) ...[
            const SizedBox(height: 14),
            TextField(
              key: const Key('rider-rating-comment'),
              controller: _comment,
              maxLength: _maxComment,
              minLines: 2,
              maxLines: 4,
              enabled: !_busy,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(hintText: 'Anything to add? (optional)', counterText: ''),
            ),
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                key: const Key('rider-rating-submit'),
                onPressed: _busy ? null : _submit,
                child: _busy
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Submit rider rating'),
              ),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(color: c.deal, fontSize: 13, fontWeight: FontWeight.w600)),
          ],
        ],
      ),
    );
  }
}

String _callable(String? phone) {
  if (phone == null) return '';
  final d = phone.replaceAll(RegExp(r'[^\d+]'), '');
  if (RegExp(r'^\d{10}$').hasMatch(d)) return '+91$d';
  return d.replaceAll(RegExp(r'\D'), '').length >= 10 ? d : '';
}

/// The courier as an ID card: who's coming, their Deligro ID, and a call.
class _CourierCard extends StatelessWidget {
  const _CourierCard({required this.rider});
  final Rider rider;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final tel = _callable(rider.phone);
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: Column(
        children: [
          Container(
            color: c.ink,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            child: Row(
              children: [
                Expanded(
                  child: Text('DELIGRO RIDER',
                      style: TextStyle(
                          color: c.surface, fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 2)),
                ),
                Icon(Icons.verified_user_rounded, size: 12, color: c.surface.withValues(alpha: .7)),
                const SizedBox(width: 4),
                Text('VERIFIED',
                    style: TextStyle(
                        color: c.surface.withValues(alpha: .7),
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 1.4)),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                Container(
                  width: 54,
                  height: 54,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(12)),
                  child: Text(rider.name.isEmpty ? '?' : rider.name.characters.first.toUpperCase(),
                      style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(rider.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
                      if (rider.id != null && rider.id!.isNotEmpty)
                        Text('ID ${rider.id}',
                            style: dataStyle(context, size: 11.5, weight: FontWeight.w700)
                                .copyWith(color: c.muted, letterSpacing: 1.2)),
                      const SizedBox(height: 2),
                      Text('Bringing your order to the door', style: TextStyle(fontSize: 12, color: c.muted)),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Semantics(
                  button: true,
                  label: tel.isEmpty ? 'No phone number recorded for this rider' : 'Call ${rider.name}',
                  excludeSemantics: true,
                  child: FilledButton(
                    onPressed: tel.isEmpty ? null : () => launchUrl(Uri(scheme: 'tel', path: tel)),
                    style: FilledButton.styleFrom(
                      minimumSize: const Size(60, 56),
                      padding: const EdgeInsets.symmetric(horizontal: 14),
                    ),
                    child: const Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.call_rounded, size: 20),
                        SizedBox(height: 2),
                        Text('CALL', style: TextStyle(fontSize: 11, letterSpacing: 1)),
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

/// What to call the total — never "(Cash)" on an order paid online.
String _totalLabel(Order o, bool delivered) {
  if (o.paymentStatus == 'refunded') return 'Total refunded';
  if (o.paymentStatus == 'paid') return 'Total paid';
  if (o.paymentMethod == 'online') return 'Total (online, unpaid)';
  return delivered ? 'Total paid (Cash)' : 'Total (Cash)';
}

class _BillCard extends StatelessWidget {
  const _BillCard({required this.order, required this.delivered});
  final Order order;
  final bool delivered;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final o = order;
    final payState = switch (o.paymentStatus) {
      'paid' => ('Paid', c.green),
      'refunded' => ('Refunded', c.blue),
      'failed' => ('Failed', c.deal),
      _ => (o.paymentMethod == 'online' ? 'Unpaid' : (delivered ? 'Paid' : 'Pay at the door'), c.muted),
    };
    return Panel(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Order ${o.shortId}', style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800)),
          const SizedBox(height: 10),
          for (final l in o.lines)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(padding: const EdgeInsets.only(top: 3), child: VegMark(l.veg, size: 12)),
                  if (l.veg != null) const SizedBox(width: 8),
                  Expanded(
                    child: Text.rich(TextSpan(
                      text: '${l.qty}× ',
                      style: TextStyle(color: c.muted, fontSize: 14),
                      children: [
                        TextSpan(text: l.name, style: TextStyle(color: c.ink)),
                        if (l.addons.isNotEmpty) TextSpan(text: '\n+ ${l.addons.join(', ')}', style: const TextStyle(fontSize: 12.5)),
                      ],
                    )),
                  ),
                  const SizedBox(width: 8),
                  Text(rupees(l.qty * l.price), style: dataStyle(context)),
                ],
              ),
            ),
          const Divider(height: 24),
          BillRow('Subtotal', rupees(o.subtotal)),
          BillRow('Delivery', o.deliveryFee == 0 ? 'Free' : rupees(o.deliveryFee), highlight: o.deliveryFee == 0),
          if (o.tax > 0) BillRow('Taxes', rupees(o.tax)),
          if (o.tip > 0) BillRow('Tip for the rider', rupees(o.tip)),
          if (o.discount > 0)
            BillRow(
              o.couponCode?.isNotEmpty == true ? 'Discount (${o.couponCode})' : 'Discount',
              rupees(o.discount),
              negative: true,
            ),
          const Divider(height: 22),
          BillRow(_totalLabel(o, delivered), rupees(o.total), bold: true),
          const SizedBox(height: 10),
          Row(
            children: [
              Icon(o.paymentMethod == 'online' ? Icons.credit_card_rounded : Icons.payments_outlined,
                  size: 16, color: c.muted),
              const SizedBox(width: 6),
              Expanded(
                child: Text(o.paymentMethod == 'online' ? 'Online payment' : 'Cash on delivery',
                    style: TextStyle(color: c.muted, fontSize: 13)),
              ),
              Text(payState.$1, style: TextStyle(color: payState.$2, fontSize: 13, fontWeight: FontWeight.w700)),
            ],
          ),
        ],
      ),
    );
  }
}

/// "Request a refund" on a finished, paid order.
class _RefundButton extends ConsumerStatefulWidget {
  const _RefundButton({required this.order});
  final Order order;

  @override
  ConsumerState<_RefundButton> createState() => _RefundButtonState();
}

class _RefundButtonState extends ConsumerState<_RefundButton> {
  bool _requested = false;

  Future<void> _open() async {
    final sent = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (_) => _RefundSheet(order: widget.order),
    );
    if (sent == true && mounted) {
      setState(() => _requested = true);
      ref.invalidate(orderProvider(widget.order.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    if (_requested) {
      return Container(
        height: 48,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: c.surface,
          borderRadius: BorderRadius.circular(radiusBlock),
          border: Border.all(color: c.line),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.check_rounded, size: 18, color: c.green),
            const SizedBox(width: 6),
            Text('Refund requested · we\'re reviewing it',
                style: TextStyle(color: c.muted, fontWeight: FontWeight.w700, fontSize: 14)),
          ],
        ),
      );
    }
    return OutlinedButton.icon(
      onPressed: _open,
      icon: const Icon(Icons.currency_rupee_rounded, size: 18),
      label: const Text('Request a refund'),
    );
  }
}

class _RefundSheet extends ConsumerStatefulWidget {
  const _RefundSheet({required this.order});
  final Order order;

  @override
  ConsumerState<_RefundSheet> createState() => _RefundSheetState();
}

class _RefundSheetState extends ConsumerState<_RefundSheet> {
  final _reason = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reason.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(orderRepoProvider).requestRefund(widget.order.id, _reason.text.trim());
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      if (!mounted) return;
      // Already open is the state the button was trying to reach.
      if (e.code == 'already_requested') {
        Navigator.pop(context, true);
        return;
      }
      setState(() => _error = e.status == 429
          ? 'Too many requests. Wait a moment and try again.'
          : e.code == 'invalid_state'
              ? 'Refunds can only be requested once an order is delivered or cancelled.'
              : e.friendly);
    } catch (_) {
      if (mounted) setState(() => _error = 'Couldn\'t send the request. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Request a refund', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            Text.rich(
              TextSpan(
                style: TextStyle(color: c.muted, fontSize: 14, height: 1.45),
                children: [
                  const TextSpan(text: 'We\'ll review your request for the full order — '),
                  TextSpan(text: rupees(widget.order.total), style: dataStyle(context, weight: FontWeight.w700)),
                  const TextSpan(text: '. If it\'s approved the money goes back to however you paid.'),
                ],
              ),
            ),
            const SizedBox(height: 16),
            TextField(
              controller: _reason,
              autofocus: true,
              maxLength: 500,
              minLines: 3,
              maxLines: 5,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                labelText: 'What went wrong?',
                hintText: 'Missing items, food arrived cold, never delivered…',
                alignLabelWithHint: true,
              ),
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(_error!, style: TextStyle(color: c.deal, fontSize: 13, fontWeight: FontWeight.w600)),
              ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy || _reason.text.trim().isEmpty ? null : _submit,
              child: _busy
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Send request'),
            ),
          ],
        ),
      ),
    );
  }
}

class _TrackingSkeleton extends StatelessWidget {
  const _TrackingSkeleton();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    Widget box(double h, {double? w, double r = 12}) => Container(
          height: h,
          width: w,
          decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(r)),
        );
    return ListView(
      padding: EdgeInsets.zero,
      children: [
        box(240, r: 0),
        Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: [
              box(14, w: 160),
              const SizedBox(height: 10),
              box(34, w: 240),
              const SizedBox(height: 24),
              box(200, r: radiusBlock),
              const SizedBox(height: 14),
              box(160, r: radiusBlock),
            ],
          ),
        ),
      ],
    );
  }
}
