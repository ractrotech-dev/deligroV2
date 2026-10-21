import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../models/live.dart';
import '../../state/live.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/polling.dart';
import '../../widgets/zone_picker.dart';
import '../orders/order_actions_bar.dart';
import '../orders/order_detail_screen.dart' show callNumber;
import '../orders/order_labels.dart';
import '../orders/orders_screen.dart' show wideBreakpoint;
import 'intervention_sheet.dart';
import 'live_map.dart';
import 'live_panels.dart';

/// The Live tab (§6): riders and active orders on a map, the lanes, what has
/// no rider, what is late, and the signals that need a human — re-asked every
/// 10 s while on screen. A phone gets the map full-height with a sheet over
/// it; a tablet gets the panel beside the map.
///
/// [query] may carry `focus=<orderId>` (a push, the dashboard's "Riders
/// currently on delivery"), which centres the map on that order.
class LiveScreen extends ConsumerStatefulWidget {
  const LiveScreen({super.key, this.query, this.onNavigate});

  final Uri? query;

  /// Where a lane or an order leads; defaults to the router (a list switches
  /// tab, an order is pushed over it).
  final void Function(String path)? onNavigate;

  @override
  ConsumerState<LiveScreen> createState() => _LiveScreenState();
}

class _LiveScreenState extends ConsumerState<LiveScreen> {
  LiveSection _section = LiveSection.lanes;

  String? get _focus => widget.query?.queryParameters['focus'];

  void _go(String path) {
    final custom = widget.onNavigate;
    if (custom != null) {
      custom(path);
      return;
    }
    final router = GoRouter.maybeOf(context);
    if (router == null) return;
    if (path.startsWith('/orders/')) {
      router.push(path);
    } else {
      router.go(path);
    }
  }

  OrderActionFlows _flows(String orderId) => OrderActionFlows(
        context: context,
        orderId: orderId,
        send: (a) => ref.read(ordersRepoProvider).act(orderId, a),
        afterDone: () => ref.read(liveSnapshotProvider.notifier).refresh(),
      );

  void _openOrder(String id) => _go('/orders/$id');

  void _rider(LiveSnapshot s, LiveRider r) {
    final c = context.colors;
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
          children: [
            Row(children: [
              Expanded(
                child: Text([r.name, ?r.code].join(' · '), style: Theme.of(ctx).textTheme.titleLarge),
              ),
              if (r.phone != null)
                IconButton.filledTonal(tooltip: 'Call', onPressed: () => callNumber(r.phone!), icon: const Icon(Icons.call)),
            ]),
            const SizedBox(height: 6),
            StatusText(riderStateLabel(r), color: riderColor(c, r), size: 14),
            const SizedBox(height: 4),
            Text(fixAgeText(r.lastFixAgeSeconds), style: TextStyle(color: r.stale ? c.deal : c.muted)),
            const SizedBox(height: 12),
            if (r.activeOrderIds.isEmpty)
              Text('No active orders.', style: TextStyle(color: c.muted))
            else
              for (final id in r.activeOrderIds)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.receipt_long_outlined),
                  title: Text(s.order(id)?.item.code ?? id.substring(0, 8).toUpperCase()),
                  subtitle: s.order(id) == null ? null : Text(s.order(id)!.item.vendor.name),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () {
                    Navigator.pop(ctx);
                    _openOrder(id);
                  },
                ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final value = ref.watch(liveSnapshotProvider);
    final s = value.value;

    Widget body;
    if (me?.hasNoZones ?? false) {
      body = const Padding(padding: EdgeInsets.all(16), child: NoZonesNotice());
    } else if (s == null) {
      if (value.hasError) {
        final e = value.error!;
        if (e is ApiException && e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
        body = ErrorRetry(error: e, onRetry: () => ref.invalidate(liveSnapshotProvider));
      } else {
        body = const Center(child: CircularProgressIndicator());
      }
    } else {
      body = Polling(
        interval: liveRefresh,
        onTick: () => ref.read(liveSnapshotProvider.notifier).refresh(),
        child: LayoutBuilder(builder: (context, box) {
          final canAssign = me == null || me.isAdmin || me.can('manager.assign_rider');
          LivePanel panel({ScrollController? controller, bool handle = false}) => LivePanel(
                snapshot: s,
                section: _section,
                onSection: (v) => setState(() => _section = v),
                onLane: (w) => _go('/orders?status=$w'),
                onAssign: (o) => _flows(o.item.id).pickRider(reassign: false),
                onIntervene: (o) => showInterventionSheet(
                  context,
                  order: o,
                  flows: _flows(o.item.id),
                  me: me,
                  onOpen: () => _openOrder(o.item.id),
                ),
                onOpenOrder: _openOrder,
                onRider: (r) => _rider(s, r),
                controller: controller,
                canAssign: canAssign,
                showHandle: handle,
              );
          final map = LiveMap(
            snapshot: s,
            focusOrderId: _focus,
            bottomInset: box.maxWidth >= wideBreakpoint ? 0 : box.maxHeight * 0.42,
            onRider: (r) => _rider(s, r),
            onOrder: (o) => _openOrder(o.item.id),
          );
          if (box.maxWidth >= wideBreakpoint) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(child: map),
                Container(
                  key: const Key('live-side-panel'),
                  width: 380,
                  decoration: BoxDecoration(border: Border(left: BorderSide(color: c.line))),
                  child: Material(color: c.surface, child: panel()),
                ),
              ],
            );
          }
          return Stack(
            children: [
              Positioned.fill(child: map),
              DraggableScrollableSheet(
                initialChildSize: 0.46,
                minChildSize: 0.14,
                maxChildSize: 0.92,
                snap: true,
                builder: (context, controller) => Material(
                  color: c.surface,
                  elevation: 8,
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(radiusSheet)),
                  clipBehavior: Clip.antiAlias,
                  child: panel(controller: controller, handle: true),
                ),
              ),
            ],
          );
        }),
      );
    }

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        backgroundColor: c.bg,
        title: const Text('Live'),
        actions: const [Padding(padding: EdgeInsets.only(right: 12), child: ZonePickerChip())],
      ),
      body: body,
    );
  }
}
