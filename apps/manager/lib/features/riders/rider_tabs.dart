import 'package:cross_file/cross_file.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'package:latlong2/latlong.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/orders.dart';
import '../../models/outcome.dart';
import '../../models/rider.dart';
import '../../state/providers.dart';
import '../../state/riders.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/contact_buttons.dart';
import '../../widgets/document_picker.dart';
import '../orders/order_actions_bar.dart' show OrderActionFlows, refusalText;
import '../orders/order_labels.dart' show StatusText;
import '../orders/order_mini_map.dart';
import '../support/ticket_labels.dart' show TicketSummaryTile;
import '../vendors/vendor_tabs.dart'
    show Figure, FactRow, InfoSection, RatingDistribution;
import 'rider_actions.dart';
import 'rider_tile.dart' show staleFixSeconds;

String _pct(double? r) => r == null ? '—' : '${(r * 100).toStringAsFixed(1)}%';
String _min(double? m) => m == null ? '—' : '${m.toStringAsFixed(1)} min';
String _hours(double? h) => h == null ? '—' : '${h.toStringAsFixed(1)} h';
String _time(DateTime? t) =>
    t == null ? '—' : DateFormat('h:mm a').format(t.toLocal());

Widget _scroll(List<Widget> children) => ListView(
  padding: const EdgeInsets.fromLTRB(16, 4, 16, 32),
  children: children,
);

// ── Overview ──────────────────────────────────────────────────────────────

/// Where the rider is and what they are carrying (§5.7–5.9): the map with
/// their position (only while online or on a delivery), each active
/// delivery's shop, drop and route with its ETA and any delay, Reassign per
/// delivery, Assign an order, and the profile facts.
class RiderOverviewTab extends ConsumerWidget {
  const RiderOverviewTab({super.key, required this.rider});
  final RiderDetail rider;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final r = rider;
    final p = r.profile;
    final me = ref.watch(managerMeProvider).value;
    final canReassign = me?.can('manager.reassign_rider') ?? false;
    return _scroll([
      const SizedBox(height: 8),
      RiderMap(rider: r),
      if (r.availability.position == null)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(
            'Location shown only while the rider is online or on a delivery.',
            style: TextStyle(color: c.muted, fontSize: 13),
          ),
        ),
      if (r.availability.onlineSince != null ||
          r.availability.breakUntil != null)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text(
            [
              if (r.availability.onlineSince != null)
                'Online since ${_time(r.availability.onlineSince)}',
              if (r.availability.breakUntil != null)
                'On a break until ${_time(r.availability.breakUntil)}',
            ].join(' · '),
            style: TextStyle(color: c.ink, fontSize: 13),
          ),
        ),
      InfoSection(
        title: r.active.isEmpty ? 'No active delivery' : 'Active deliveries',
        trailing: r.allowed.assign
            ? TextButton.icon(
                key: const Key('rider-assign-order'),
                onPressed: () => _assignOrder(context, ref, r),
                icon: const Icon(Icons.add_task, size: 18),
                label: const Text('Assign an order'),
              )
            : null,
        children: [
          for (final a in r.active)
            _ActiveRow(rider: r, delivery: a, canReassign: canReassign),
        ],
      ),
      InfoSection(
        title: 'Vehicle and licence',
        children: [
          FactRow('Vehicle', p.vehicleType.label),
          FactRow(
            'Owned by',
            p.vehicleOwner == 'rider' ? 'The rider' : 'Deligro',
          ),
          if (p.vehicleRegistration != null)
            FactRow('Registration', p.vehicleRegistration!, mono: true),
          if (p.licenceNumberMasked != null)
            FactRow('Licence', p.licenceNumberMasked!, mono: true),
          if (p.licenceExpiresOn != null)
            FactRow('Licence expires', p.licenceExpiresOn!, mono: true),
        ],
      ),
      InfoSection(
        title: 'Contact',
        children: [
          if (p.address != null)
            FactRow('Address', [p.address!, ?p.pincode].join(', ')),
          if (p.emergency.name != null)
            FactRow(
              'Emergency contact',
              [p.emergency.name!, ?p.emergency.relation].join(', '),
            ),
          if (p.emergency.phone != null) ...[
            FactRow('Emergency phone', p.emergency.phone!, mono: true),
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: ContactButtons(
                key: const Key('rider-emergency-contact'),
                phone: p.emergency.phone!,
                whatsapp: false,
              ),
            ),
          ],
          if (p.joinedAt != null)
            FactRow(
              'Joined',
              DateFormat('d MMM yyyy').format(p.joinedAt!.toLocal()),
            ),
          if (r.summary.zones.isNotEmpty)
            FactRow('Zones', r.summary.zones.map((z) => z.name).join(', ')),
        ],
      ),
    ]);
  }
}

class _ActiveRow extends ConsumerWidget {
  const _ActiveRow({
    required this.rider,
    required this.delivery,
    required this.canReassign,
  });
  final RiderDetail rider;
  final ActiveDelivery delivery;
  final bool canReassign;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final a = delivery;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 10,
            runSpacing: 4,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              InkWell(
                onTap: () =>
                    GoRouter.maybeOf(context)?.push('/orders/${a.orderId}'),
                child: Text(
                  a.code,
                  style: dataStyle(
                    context,
                    size: 14,
                    weight: FontWeight.w700,
                  ).copyWith(color: c.accentInk),
                ),
              ),
              StatusText(
                a.pickedUp ? 'Picked up' : 'Going to the shop',
                color: c.accent,
              ),
              if (a.delay != null)
                StatusText('${a.delay!.minutes} min late', color: c.deal),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            [
              if (a.shop.name != null) 'From ${a.shop.name}',
              if (a.drop.area != null) 'to ${a.drop.area}',
            ].join(' '),
            style: TextStyle(fontSize: 13, color: c.ink),
          ),
          Text(
            [
              if (!a.pickedUp && a.etaPickupAt != null)
                'Pickup ~${_time(a.etaPickupAt)}',
              if (a.etaDeliveryAt != null)
                'Delivery ~${_time(a.etaDeliveryAt)}',
            ].join(' · '),
            style: TextStyle(fontSize: 12.5, color: c.muted),
          ),
          if (canReassign)
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: Key('rider-reassign-${a.orderId}'),
                onPressed: () =>
                    OrderActionFlows(
                      context: context,
                      orderId: a.orderId,
                      send: (action) =>
                          ref.read(ordersRepoProvider).act(a.orderId, action),
                      afterDone: () => ref
                          .read(riderDetailProvider(rider.id).notifier)
                          .refresh(),
                    ).pickRider(
                      reassign: true,
                      pickedUp: a.pickedUp,
                      currentRider: rider.name,
                    ),
                icon: const Icon(Icons.swap_horiz, size: 18),
                label: const Text('Reassign'),
              ),
            ),
        ],
      ),
    );
  }
}

/// Lists the unassigned orders in scope and puts this rider on the one the
/// manager picks (Phase 3's assign action, audited there).
Future<void> _assignOrder(
  BuildContext context,
  WidgetRef ref,
  RiderDetail rider,
) async {
  final OrderPage page;
  try {
    page = await ref
        .read(ordersRepoProvider)
        .list(const OrderFilters(queue: OrderQueue.unassigned));
  } on ApiException catch (e) {
    if (context.mounted) showSnack(context, e.friendly);
    return;
  }
  if (!context.mounted) return;
  final order = await showModalBottomSheet<OrderListItem>(
    context: context,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: page.items.isEmpty
          ? const Padding(
              padding: EdgeInsets.all(24),
              child: Text('No orders are waiting for a rider.'),
            )
          : ListView(
              shrinkWrap: true,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                  child: Text(
                    'Put ${rider.name} on…',
                    style: Theme.of(ctx).textTheme.titleLarge,
                  ),
                ),
                for (final o in page.items)
                  ListTile(
                    key: Key('assign-pick-${o.id}'),
                    title: Text('${o.code} · ${o.vendor.name}'),
                    subtitle: Text(placedAt(o.createdAt)),
                    onTap: () => Navigator.pop(ctx, o),
                  ),
              ],
            ),
    ),
  );
  if (order == null || !context.mounted) return;
  final action = Assign(riderId: rider.id);
  Future<void> send() async {
    try {
      final out = await ref.read(ordersRepoProvider).act(order.id, action);
      if (!context.mounted) return;
      switch (out) {
        case ActionDone():
          showSnack(context, '${rider.name} is on ${order.code}.');
          await ref.read(riderDetailProvider(rider.id).notifier).refresh();
        case ActionRefused():
          showSnack(context, refusalText(out));
      }
    } on ApiException catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(e.friendly),
            action: SnackBarAction(label: 'Retry', onPressed: send),
          ),
        );
    }
  }

  await send();
}

/// The rider's position and each active delivery's pins and route.
class RiderMap extends ConsumerWidget {
  const RiderMap({super.key, required this.rider, this.height = 220});
  final RiderDetail rider;
  final double height;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final pos = rider.availability.position;
    final me = pos == null ? null : LatLng(pos.lat, pos.lng);
    final stale =
        (rider.summary.fixAgeSeconds ?? staleFixSeconds + 1) > staleFixSeconds;
    final shops = [
      for (final a in rider.active)
        if (a.shop.hasPoint) LatLng(a.shop.lat!, a.shop.lng!),
    ];
    final drops = [
      for (final a in rider.active)
        if (a.drop.hasPoint) LatLng(a.drop.lat!, a.drop.lng!),
    ];
    final points = [?me, ...shops, ...drops];
    if (points.isEmpty) return const SizedBox.shrink();
    final tiles = ref.watch(mapTilesEnabledProvider);
    return ClipRRect(
      borderRadius: BorderRadius.circular(radiusBlock),
      child: SizedBox(
        height: height,
        child: DecoratedBox(
          decoration: BoxDecoration(color: c.surface2),
          child: Stack(
            children: [
              Positioned.fill(
                child: FlutterMap(
                  options: MapOptions(
                    initialCenter: points.first,
                    initialZoom: 14,
                    initialCameraFit: points.length < 2
                        ? null
                        : CameraFit.coordinates(
                            coordinates: points,
                            padding: const EdgeInsets.all(36),
                            maxZoom: 16,
                          ),
                    interactionOptions: const InteractionOptions(
                      flags: InteractiveFlag.all & ~InteractiveFlag.rotate,
                    ),
                  ),
                  children: [
                    if (tiles) osmTiles(),
                    PolylineLayer(
                      polylines: [
                        for (final a in rider.active)
                          if (a.route.length >= 2)
                            // A straight line through the stops still ahead, not a
                            // road route: dashed so it never reads as directions.
                            Polyline(
                              points: [
                                for (final (lat, lng) in a.route)
                                  LatLng(lat, lng),
                              ],
                              color: c.accent.withValues(alpha: .7),
                              strokeWidth: 4,
                              pattern: StrokePattern.dashed(
                                segments: const [10, 8],
                              ),
                            ),
                      ],
                    ),
                    MarkerLayer(
                      markers: [
                        for (final s in shops)
                          Marker(
                            point: s,
                            width: 34,
                            height: 34,
                            child: MapPin(
                              icon: Icons.storefront_rounded,
                              color: c.accent,
                              fg: c.onAccent,
                              label: 'Shop',
                            ),
                          ),
                        for (final d in drops)
                          Marker(
                            point: d,
                            width: 34,
                            height: 34,
                            child: MapPin(
                              icon: Icons.home_rounded,
                              color: c.ink,
                              fg: c.surface,
                              label: 'Customer',
                            ),
                          ),
                        if (me != null)
                          Marker(
                            point: me,
                            width: 36,
                            height: 36,
                            child: MapPin(
                              icon: Icons.two_wheeler,
                              color: stale ? c.muted : c.green,
                              fg: Colors.white,
                              label: stale
                                  ? 'Rider, location out of date'
                                  : 'Rider',
                            ),
                          ),
                      ],
                    ),
                  ],
                ),
              ),
              if (rider.active.any((a) => a.route.length >= 2))
                Positioned(
                  left: 8,
                  bottom: 8,
                  child: DecoratedBox(
                    key: const Key('rider-route-approx'),
                    decoration: BoxDecoration(
                      color: c.surface.withValues(alpha: .92),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      child: Text(
                        'Route: straight line, approx.',
                        style: TextStyle(fontSize: 11.5, color: c.muted),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Deliveries ────────────────────────────────────────────────────────────

/// Every delivery this rider ended (§5.10–5.11), by outcome and date range,
/// with the totals; a row opens the order.
class RiderDeliveriesTab extends ConsumerStatefulWidget {
  const RiderDeliveriesTab({super.key, required this.riderId});
  final String riderId;

  @override
  ConsumerState<RiderDeliveriesTab> createState() => _RiderDeliveriesTabState();
}

class _RiderDeliveriesTabState extends ConsumerState<RiderDeliveriesTab> {
  RiderOutcome? _outcome;
  DateTimeRange? _range;

  RiderHistoryQuery get _q => RiderHistoryQuery(
    widget.riderId,
    outcome: _outcome,
    from: _range?.start,
    to: _range?.end,
  );

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final q = _q;
    final value = ref.watch(riderHistoryProvider(q));
    final data = value.value;
    final totals = data?.counts;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
          child: Row(
            children: [
              for (final o in RiderOutcome.filters)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: FilterChip(
                    key: Key('history-outcome-${o.name}'),
                    label: Text(
                      totals == null ? o.label : '${o.label} (${totals.of(o)})',
                    ),
                    selected: _outcome == o,
                    onSelected: (on) =>
                        setState(() => _outcome = on ? o : null),
                  ),
                ),
              ActionChip(
                key: const Key('history-range'),
                avatar: const Icon(Icons.date_range, size: 18),
                label: Text(
                  _range == null
                      ? 'All dates'
                      : '${DateFormat('d MMM').format(_range!.start)} – ${DateFormat('d MMM').format(_range!.end)}',
                ),
                onPressed: () async {
                  final today = istToday();
                  final r = await showDateRangePicker(
                    context: context,
                    firstDate: DateTime(today.year - 2),
                    lastDate: today,
                    initialDateRange: _range,
                  );
                  if (r != null) setState(() => _range = r);
                },
              ),
              if (_range != null)
                IconButton(
                  tooltip: 'Clear dates',
                  onPressed: () => setState(() => _range = null),
                  icon: const Icon(Icons.close, size: 18),
                ),
            ],
          ),
        ),
        Expanded(
          child: data == null
              ? (value.hasError
                    ? ErrorRetry(
                        error: value.error!,
                        onRetry: () => ref.invalidate(riderHistoryProvider(q)),
                      )
                    : const Center(child: CircularProgressIndicator()))
              : data.items.isEmpty
              ? const EmptyLine('No deliveries match.')
              : NotificationListener<ScrollNotification>(
                  onNotification: (n) {
                    if (n.metrics.pixels >= n.metrics.maxScrollExtent * 0.8) {
                      ref.read(riderHistoryProvider(q).notifier).loadMore();
                    }
                    return false;
                  },
                  child: ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 6, 16, 32),
                    itemCount: data.items.length,
                    separatorBuilder: (_, _) =>
                        Divider(color: c.line, height: 1),
                    itemBuilder: (context, i) =>
                        _HistoryRow(item: data.items[i]),
                  ),
                ),
        ),
      ],
    );
  }
}

Color _outcomeColor(AppColors c, RiderOutcome o) => switch (o) {
  RiderOutcome.delivered => c.green,
  RiderOutcome.failed => c.deal,
  RiderOutcome.cancelled => c.muted,
  RiderOutcome.reassigned => c.amberText,
  RiderOutcome.unknown => c.muted,
};

class _HistoryRow extends StatelessWidget {
  const _HistoryRow({required this.item});
  final RiderHistoryItem item;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final h = item;
    return InkWell(
      key: Key('history-row-${h.orderId}'),
      onTap: () => GoRouter.maybeOf(context)?.push('/orders/${h.orderId}'),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  h.code,
                  style: dataStyle(
                    context,
                    size: 13.5,
                    weight: FontWeight.w700,
                  ),
                ),
                const SizedBox(width: 10),
                StatusText(h.outcome.label, color: _outcomeColor(c, h.outcome)),
                const Spacer(),
                Text(rupees(h.orderValue), style: dataStyle(context, size: 13)),
              ],
            ),
            const SizedBox(height: 3),
            Text(
              [
                ?h.shop,
                if (h.dropArea != null) 'to ${h.dropArea}',
                placedAt(h.endedAt),
              ].join(' · '),
              style: TextStyle(fontSize: 12.5, color: c.muted),
            ),
            Text(
              [
                if (h.pickedUpAt != null) 'Picked up ${_time(h.pickedUpAt)}',
                if (h.deliveredAt != null) 'Delivered ${_time(h.deliveredAt)}',
                if (h.distanceKm != null) distance(h.distanceKm!),
                if (h.proof != null) 'Proof: ${h.proof!.replaceAll('_', ' ')}',
              ].join(' · '),
              style: TextStyle(fontSize: 12.5, color: c.muted),
            ),
            if (h.reason != null)
              Text(
                [
                  h.reason!,
                  if (h.cancelledBy != null) '(${h.cancelledBy})',
                ].join(' '),
                style: TextStyle(fontSize: 12.5, color: c.ink),
              ),
          ],
        ),
      ),
    );
  }
}

// ── Performance ───────────────────────────────────────────────────────────

/// §5.12: acceptance, delivery time, failures and online hours for the last
/// 30 days and month by month, and the ratings customers gave.
class RiderPerformanceTab extends StatefulWidget {
  const RiderPerformanceTab({super.key, required this.rider});
  final RiderDetail rider;

  @override
  State<RiderPerformanceTab> createState() => _RiderPerformanceTabState();
}

class _RiderPerformanceTabState extends State<RiderPerformanceTab> {
  bool _months = false;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final p = widget.rider.performance;
    final r = widget.rider.ratings;
    return _scroll([
      const SizedBox(height: 10),
      SegmentedButton<bool>(
        segments: const [
          ButtonSegment(value: false, label: Text('Last 30 days')),
          ButtonSegment(value: true, label: Text('By month')),
        ],
        selected: {_months},
        onSelectionChanged: (s) => setState(() => _months = s.first),
      ),
      if (!_months) ...[
        const SizedBox(height: 14),
        Wrap(
          spacing: 24,
          runSpacing: 14,
          children: [
            Figure('${p.delivered}', 'Delivered'),
            Figure('${p.failed}', 'Failed'),
            Figure('${p.cancelled}', 'Cancelled'),
            Figure(_pct(p.acceptanceRate), 'Acceptance rate'),
            Figure(_min(p.avgDeliverMinutes), 'Average delivery time'),
            Figure(_min(p.avgPickupToDeliverMinutes), 'Pickup to door'),
            Figure(_pct(p.failedRate), 'Failed rate'),
            Figure(_hours(p.onlineHours), 'Online hours'),
          ],
        ),
        if (p.from != null && p.to != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              '${p.from} to ${p.to} (IST)',
              style: TextStyle(fontSize: 12, color: c.muted),
            ),
          ),
      ] else
        InfoSection(
          title: 'Month by month',
          children: p.months.isEmpty
              ? [Text('No months yet.', style: TextStyle(color: c.muted))]
              : [
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: DataTable(
                      headingTextStyle: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: c.muted,
                      ),
                      dataTextStyle: dataStyle(context, size: 13),
                      columnSpacing: 18,
                      columns: const [
                        DataColumn(label: Text('Month')),
                        DataColumn(label: Text('Delivered'), numeric: true),
                        DataColumn(label: Text('Failed'), numeric: true),
                        DataColumn(label: Text('Cancelled'), numeric: true),
                        DataColumn(label: Text('Acceptance'), numeric: true),
                        DataColumn(label: Text('Avg min'), numeric: true),
                        DataColumn(label: Text('Online h'), numeric: true),
                      ],
                      rows: [
                        for (final m in p.months)
                          DataRow(
                            cells: [
                              DataCell(Text(m.month)),
                              DataCell(Text('${m.delivered}')),
                              DataCell(Text('${m.failed}')),
                              DataCell(Text('${m.cancelled}')),
                              DataCell(Text(_pct(m.acceptanceRate))),
                              DataCell(
                                Text(
                                  m.avgDeliverMin?.toStringAsFixed(1) ?? '—',
                                ),
                              ),
                              DataCell(
                                Text(m.onlineHours?.toStringAsFixed(1) ?? '—'),
                              ),
                            ],
                          ),
                      ],
                    ),
                  ),
                ],
        ),
      InfoSection(
        title: r.average == null
            ? 'Ratings'
            : 'Ratings · ${r.average!.toStringAsFixed(1)} from ${r.count}',
        children: [
          RatingDistribution(distribution: r.distribution),
          for (final x in r.recent)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(Icons.star_rounded, size: 15, color: c.pop),
                      Text(' ${x.rating}', style: dataStyle(context, size: 13)),
                      const SizedBox(width: 8),
                      Text(
                        [?x.orderCode, placedAt(x.at)].join(' · '),
                        style: TextStyle(fontSize: 12, color: c.muted),
                      ),
                    ],
                  ),
                  if (x.comment != null)
                    Text(
                      x.comment!,
                      style: TextStyle(fontSize: 13.5, color: c.ink),
                    ),
                ],
              ),
            ),
        ],
      ),
    ]);
  }
}

// ── Documents ─────────────────────────────────────────────────────────────

Color riderDocStatusColor(AppColors c, RiderDocStatus s) => switch (s) {
  RiderDocStatus.verified => c.green,
  RiderDocStatus.pending => c.amberText,
  RiderDocStatus.rejected || RiderDocStatus.expired => c.deal,
  RiderDocStatus.replaced || RiderDocStatus.unknown => c.muted,
};

/// §5.2: the rider's documents with their state and expiry (amber within 30
/// days, red once expired), View, Verify / Reject, Upload.
class RiderDocumentsTab extends ConsumerWidget {
  const RiderDocumentsTab({super.key, required this.rider});
  final RiderDetail rider;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final today = istToday();
    final docs = rider.documents;
    return _scroll([
      if (rider.allowed.uploadDocuments)
        Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.only(top: 8),
            child: OutlinedButton.icon(
              key: const Key('rider-doc-upload'),
              onPressed: () => uploadRiderDocument(context, ref, rider),
              icon: const Icon(Icons.upload_file_outlined, size: 18),
              label: const Text('Upload a document'),
            ),
          ),
        ),
      if (docs.isEmpty)
        const EmptyLine('No documents uploaded yet.')
      else
        for (final d in docs) _DocRow(rider: rider, doc: d, today: today),
      if (!rider.allowed.reviewDocuments &&
          docs.any((d) => d.status == RiderDocStatus.pending))
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Text(
            'Reviewing documents needs the "Rider status" permission.',
            style: TextStyle(color: c.muted),
          ),
        ),
    ]);
  }
}

class _DocRow extends ConsumerWidget {
  const _DocRow({required this.rider, required this.doc, required this.today});
  final RiderDetail rider;
  final RiderDocument doc;
  final DateTime today;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final d = doc;
    final exp = d.expiryDate;
    final expiryColor = exp == null
        ? c.muted
        : exp.isBefore(today)
        ? c.deal
        : exp.difference(today).inDays <= 30
        ? c.amberText
        : c.muted;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  d.type.label,
                  style: TextStyle(
                    fontWeight: FontWeight.w700,
                    color: c.ink,
                    fontSize: 14.5,
                  ),
                ),
              ),
              StatusText(
                d.status.label,
                color: riderDocStatusColor(c, d.status),
              ),
            ],
          ),
          const SizedBox(height: 3),
          Wrap(
            spacing: 12,
            children: [
              if (d.numberMasked != null)
                Text(d.numberMasked!, style: dataStyle(context, size: 12.5)),
              if (d.expiresOn != null)
                Text(
                  exp != null && exp.isBefore(today)
                      ? 'Expired ${d.expiresOn}'
                      : 'Expires ${d.expiresOn}',
                  style: TextStyle(
                    fontSize: 12.5,
                    color: expiryColor,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              if (d.uploadedAt != null)
                Text(
                  'Uploaded ${placedAt(d.uploadedAt)}',
                  style: TextStyle(fontSize: 12.5, color: c.muted),
                ),
            ],
          ),
          if (d.remarks != null || d.reviewedBy != null)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text(
                [
                  ?d.remarks,
                  if (d.reviewedBy != null) 'by ${d.reviewedBy!.name}',
                ].join(' · '),
                style: TextStyle(fontSize: 12.5, color: c.muted),
              ),
            ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            children: [
              TextButton.icon(
                key: Key('doc-view-${d.id}'),
                onPressed: () async {
                  try {
                    final url = await ref
                        .read(ridersRepoProvider)
                        .documentUrl(rider.id, d.id);
                    final ok = await ref.read(urlOpenerProvider)(
                      Uri.parse(url),
                    );
                    if (!ok && context.mounted) {
                      showSnack(context, "Couldn't open that on this phone.");
                    }
                  } on ApiException catch (e) {
                    if (context.mounted) showSnack(context, e.friendly);
                  }
                },
                icon: const Icon(Icons.visibility_outlined, size: 18),
                label: const Text('View'),
              ),
              if (rider.allowed.reviewDocuments &&
                  d.status == RiderDocStatus.pending) ...[
                FilledButton.tonal(
                  key: Key('doc-verify-${d.id}'),
                  onPressed: () =>
                      reviewRiderDocument(context, ref, rider, d, verify: true),
                  child: const Text('Verify'),
                ),
                OutlinedButton(
                  key: Key('doc-reject-${d.id}'),
                  style: OutlinedButton.styleFrom(foregroundColor: c.deal),
                  onPressed: () => reviewRiderDocument(
                    context,
                    ref,
                    rider,
                    d,
                    verify: false,
                  ),
                  child: const Text('Reject'),
                ),
              ],
            ],
          ),
          Divider(color: c.line, height: 16),
        ],
      ),
    );
  }
}

const _uuid = Uuid();

/// Picks a type, an optional number, the expiry when the type needs one, and
/// the file; uploads it with one id so Retry is the same upload.
Future<void> uploadRiderDocument(
  BuildContext context,
  WidgetRef ref,
  RiderDetail rider,
) async {
  final form = await showDialog<_UploadForm>(
    context: context,
    builder: (_) => const _UploadDialog(),
  );
  if (form == null || !context.mounted) return;
  final file = await ref.read(documentPickerProvider)(context);
  if (file == null || !context.mounted) return;
  final problem = await riderDocumentFileProblem(file);
  if (problem != null) {
    if (context.mounted) showSnack(context, problem);
    return;
  }
  final id = _uuid.v4();
  Future<void> send() async {
    try {
      final out = await ref
          .read(ridersRepoProvider)
          .upload(
            rider.id,
            type: form.type,
            file: file,
            number: form.number,
            expiresOn: form.expiresOn,
            clientActionId: id,
          );
      if (!context.mounted) return;
      switch (out) {
        case Applied():
          showSnack(context, '${form.type.label} uploaded.');
          await ref.read(riderDetailProvider(rider.id).notifier).refresh();
        case Refused(:final code):
          showSnack(context, switch (code) {
            'bad_type' => 'Use a JPEG, PNG or PDF file.',
            'too_large' => 'That file is over 10 MB.',
            'invalid_number' => "That document number doesn't look right.",
            'expiry_required' => '${form.type.label} needs an expiry date.',
            _ => riderRefusalText(out),
          });
      }
    } on ApiException catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(e.friendly),
            action: SnackBarAction(label: 'Retry', onPressed: send),
          ),
        );
    }
  }

  await send();
}

/// The rider bucket takes JPEG, PNG and PDF up to 10 MB (no WebP).
Future<String?> riderDocumentFileProblem(XFile f) async {
  final ext = f.name.split('.').last.toLowerCase();
  if (!const ['jpg', 'jpeg', 'png', 'pdf'].contains(ext)) {
    return 'Use a JPEG, PNG or PDF file.';
  }
  if (await f.length() > documentMaxBytes) return 'That file is over 10 MB.';
  return null;
}

class _UploadForm {
  const _UploadForm(this.type, this.number, this.expiresOn);
  final RiderDocType type;
  final String? number;
  final DateTime? expiresOn;
}

class _UploadDialog extends StatefulWidget {
  const _UploadDialog();

  @override
  State<_UploadDialog> createState() => _UploadDialogState();
}

class _UploadDialogState extends State<_UploadDialog> {
  RiderDocType _type = RiderDocType.drivingLicence;
  final _number = TextEditingController();
  DateTime? _expires;

  @override
  void dispose() {
    _number.dispose();
    super.dispose();
  }

  bool get _ok => !_type.needsExpiry || _expires != null;

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('Upload a document'),
    content: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        DropdownButtonFormField<RiderDocType>(
          key: const Key('upload-type'),
          initialValue: _type,
          decoration: const InputDecoration(labelText: 'Type'),
          items: [
            for (final t in RiderDocType.values.where(
              (t) => t != RiderDocType.unknown,
            ))
              DropdownMenuItem(value: t, child: Text(t.label)),
          ],
          onChanged: (t) => setState(() => _type = t ?? _type),
        ),
        if (_type != RiderDocType.photo)
          TextField(
            key: const Key('upload-number'),
            controller: _number,
            decoration: const InputDecoration(labelText: 'Number (optional)'),
          ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: Text(
                _expires == null
                    ? (_type.needsExpiry ? 'Expiry date needed' : 'No expiry')
                    : 'Expires ${ymd(_expires!)}',
              ),
            ),
            TextButton(
              key: const Key('upload-expiry'),
              onPressed: () async {
                final today = istToday();
                final d = await showDatePicker(
                  context: context,
                  initialDate: today.add(const Duration(days: 365)),
                  firstDate: today,
                  lastDate: DateTime(today.year + 20),
                );
                if (d != null) setState(() => _expires = d);
              },
              child: const Text('Set expiry'),
            ),
          ],
        ),
      ],
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('Back'),
      ),
      FilledButton(
        onPressed: _ok
            ? () => Navigator.pop(
                context,
                _UploadForm(
                  _type,
                  _number.text.trim().isEmpty ? null : _number.text.trim(),
                  _expires,
                ),
              )
            : null,
        child: const Text('Choose file'),
      ),
    ],
  );
}

// ── Complaints ────────────────────────────────────────────────────────────

/// §5.15: complaints and support requests about or from this rider; a row
/// opens the ticket thread.
class RiderComplaintsTab extends StatelessWidget {
  const RiderComplaintsTab({super.key, required this.rider});
  final RiderDetail rider;

  @override
  Widget build(BuildContext context) {
    final tickets = rider.openComplaints;
    if (tickets.isEmpty) {
      return _scroll(const [EmptyLine('No open complaints.')]);
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 32),
      itemCount: tickets.length,
      separatorBuilder: (_, _) => const SizedBox(height: 10),
      itemBuilder: (context, i) => TicketSummaryTile(
        ticket: tickets[i],
        onTap: () =>
            GoRouter.maybeOf(context)?.push('/more/tickets/${tickets[i].id}'),
      ),
    );
  }
}
