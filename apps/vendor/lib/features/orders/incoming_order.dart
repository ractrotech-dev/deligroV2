import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../models/order.dart';
import '../../state/orders.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import 'order_actions.dart';

/// Whether the shell offers new orders in a popup. Always on in the app;
/// screen tests whose fake board holds a new order turn it off.
final incomingPopupProvider = Provider<bool>((_) => true);

/// How long "Later" keeps one order's popup away. The ring carries on meanwhile.
const incomingSnooze = Duration(minutes: 2);

/// The order the popup should offer next: the one that has waited longest,
/// skipping any the vendor put off with "Later" until that runs out.
VendorOrder? nextIncoming(Iterable<VendorOrder> orders, Map<String, DateTime> snoozedUntil, DateTime now) {
  final waiting =
      orders
          .where((o) => o.stage == OrderStage.newOrder)
          .where((o) => !(snoozedUntil[o.id]?.isAfter(now) ?? false))
          .toList()
        ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
  return waiting.isEmpty ? null : waiting.first;
}

/// "0:42", "3:05".
String waitedText(Duration d) {
  final s = d.isNegative ? 0 : d.inSeconds;
  return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
}

/// What the popup ended with.
enum IncomingOutcome { handled, later, details }

/// The "NEW ORDER" card over whatever screen is open, so a new order is
/// accepted or rejected where the vendor is rather than from the Orders tab.
/// It follows the live board: once the order leaves New (accepted on another
/// phone, on the website, or cancelled by the customer) it closes by itself.
class IncomingOrderDialog extends ConsumerStatefulWidget {
  const IncomingOrderDialog({super.key, required this.orderId});
  final String orderId;

  @override
  ConsumerState<IncomingOrderDialog> createState() => _IncomingOrderDialogState();
}

class _IncomingOrderDialogState extends ConsumerState<IncomingOrderDialog> {
  late final Timer _tick;
  bool _busy = false;
  bool _closed = false;
  String? _error;
  VendorOrder? _last;

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) => mounted ? setState(() {}) : null);
  }

  @override
  void dispose() {
    _tick.cancel();
    super.dispose();
  }

  void _close(IncomingOutcome outcome) {
    if (_closed || !mounted) return;
    _closed = true;
    Navigator.of(context).pop(outcome);
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
      await ref.read(boardProvider.notifier).refresh();
      _close(IncomingOutcome.handled);
    } on ApiException catch (e) {
      // A 409 means it moved meanwhile; the refreshed board closes the popup.
      await ref.read(boardProvider.notifier).refresh();
      if (mounted) setState(() => _error = e.friendly());
    } catch (_) {
      if (mounted) setState(() => _error = 'Something went wrong. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _accept(VendorOrder o) async {
    final shopPrep = ref.read(vendorMeProvider).value?.activeShop.prepMinutes ?? 20;
    final minutes = await showAcceptSheet(context, defaultMinutes: o.prepMinutes ?? shopPrep);
    if (minutes == null || !mounted) return;
    await _run(() => ref.read(ordersRepoProvider).accept(o.id, prepMinutes: minutes));
  }

  Future<void> _reject(VendorOrder o) async {
    final reason = await showRejectSheet(context);
    if (reason == null || !mounted) return;
    await _run(() => ref.read(ordersRepoProvider).reject(o.id, reason));
  }

  @override
  Widget build(BuildContext context) {
    final board = ref.watch(boardProvider).value;
    final live = board?.orders.where((o) => o.id == widget.orderId).firstOrNull;
    if (board != null && (live == null || live.stage != OrderStage.newOrder) && !_busy) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _close(IncomingOutcome.handled));
    }
    final o = live ?? _last;
    _last = o;
    if (o == null) return const SizedBox.shrink();
    final others = (board?.orders ?? const []).where((x) => x.stage == OrderStage.newOrder && x.id != o.id).length;
    final c = context.colors;
    final waited = DateTime.now().difference(o.createdAt);
    final overdue = waited >= const Duration(minutes: 3);

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && !_busy) _close(IncomingOutcome.later);
      },
      child: Dialog(
        insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusSheet),
          side: BorderSide(color: c.accent, width: 2),
        ),
        backgroundColor: c.surface,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                color: c.accent,
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                child: Row(
                  children: [
                    Icon(Icons.notifications_active_rounded, color: c.onAccent, size: 20),
                    const SizedBox(width: 8),
                    Text(
                      'NEW ORDER',
                      style: TextStyle(color: c.onAccent, fontWeight: FontWeight.w800, letterSpacing: .6, fontSize: 14),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Waiting ${waitedText(waited)}',
                        textAlign: TextAlign.end,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: c.onAccent, fontWeight: FontWeight.w700, fontSize: 13),
                      ),
                    ),
                  ],
                ),
              ),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.baseline,
                        textBaseline: TextBaseline.alphabetic,
                        children: [
                          Expanded(
                            child: Text(
                              'Order ${o.code}',
                              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                            ),
                          ),
                          Text(rupees(o.total), style: dataStyle(context, size: 20, weight: FontWeight.w800)),
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        [o.customerName, if (o.area.isNotEmpty) o.area].join(' · '),
                        style: TextStyle(color: c.muted, fontSize: 13),
                      ),
                      const SizedBox(height: 10),
                      Container(
                        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
                        decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(radiusBlock)),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            for (final l in o.lines)
                              Padding(
                                padding: const EdgeInsets.symmetric(vertical: 3),
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    SizedBox(
                                      width: 36,
                                      child: Text('${l.qty} ×', style: const TextStyle(fontWeight: FontWeight.w800)),
                                    ),
                                    Expanded(
                                      child: Text(
                                        l.addons.isEmpty ? l.name : '${l.name}\n+ ${l.addons.join(', ')}',
                                        style: const TextStyle(fontSize: 14, height: 1.3),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            if (o.lines.isEmpty) Text('${o.itemCount} items', style: TextStyle(color: c.muted)),
                          ],
                        ),
                      ),
                      const SizedBox(height: 10),
                      Wrap(
                        spacing: 8,
                        runSpacing: 6,
                        children: [
                          _Chip(
                            o.isCod ? 'Cash on delivery' : (o.paymentStatus == 'paid' ? 'Paid online' : 'Online'),
                            fg: o.isCod ? c.accentInk : c.green,
                            bg: o.isCod ? c.accentSoft : c.greenSoft,
                          ),
                          if (others > 0) _Chip('+$others more waiting', fg: c.ink, bg: c.surface2),
                          if (overdue) _Chip('Waiting over 3 min', fg: c.deal, bg: c.dealSoft),
                        ],
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 10),
                        Text(
                          _error!,
                          style: TextStyle(color: c.deal, fontWeight: FontWeight.w600),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          backgroundColor: c.green,
                          foregroundColor: Colors.white,
                          minimumSize: const Size.fromHeight(48),
                        ),
                        onPressed: _busy ? null : () => _accept(o),
                        icon: _busy
                            ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                            : const Icon(Icons.check_rounded),
                        label: const FittedBox(
                          child: Text('Accept', style: TextStyle(fontWeight: FontWeight.w800)),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: FilledButton.icon(
                        style: FilledButton.styleFrom(
                          backgroundColor: c.dealSoft,
                          foregroundColor: c.deal,
                          minimumSize: const Size.fromHeight(48),
                        ),
                        onPressed: _busy ? null : () => _reject(o),
                        icon: const Icon(Icons.close_rounded),
                        label: const FittedBox(
                          child: Text('Reject', style: TextStyle(fontWeight: FontWeight.w800)),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 6),
                child: OverflowBar(
                  alignment: MainAxisAlignment.spaceBetween,
                  overflowAlignment: OverflowBarAlignment.center,
                  children: [
                    TextButton(
                      onPressed: _busy ? null : () => _close(IncomingOutcome.later),
                      child: const Text('Later'),
                    ),
                    TextButton(
                      onPressed: _busy ? null : () => _close(IncomingOutcome.details),
                      child: const Text('View details'),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip(this.label, {required this.fg, required this.bg});
  final String label;
  final Color fg;
  final Color bg;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
    decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
    child: Text(
      label,
      style: TextStyle(color: fg, fontSize: 12, fontWeight: FontWeight.w700),
    ),
  );
}

/// Shows [IncomingOrderDialog] for the next waiting order, one at a time, on
/// the root navigator so it sits above every tab and pushed screen.
class IncomingOrderPresenter {
  IncomingOrderPresenter(this._navigatorKey);
  final GlobalKey<NavigatorState> _navigatorKey;
  final _snoozed = <String, DateTime>{};
  String? _showing;

  bool get showing => _showing != null;

  /// True when a popup was shown (and has now closed).
  Future<bool> offer(Iterable<VendorOrder> orders) async {
    if (_showing != null) return false;
    final ctx = _navigatorKey.currentContext;
    if (ctx == null || !ctx.mounted) return false;
    final now = DateTime.now();
    _snoozed.removeWhere((_, until) => !until.isAfter(now));
    final next = nextIncoming(orders, _snoozed, now);
    if (next == null) return false;
    _showing = next.id;
    try {
      final outcome = await showDialog<IncomingOutcome>(
        context: ctx,
        barrierDismissible: false,
        useRootNavigator: true,
        builder: (_) => IncomingOrderDialog(orderId: next.id),
      );
      if (outcome == IncomingOutcome.later) _snoozed[next.id] = DateTime.now().add(incomingSnooze);
      if (outcome == IncomingOutcome.details) {
        // Dealt with from the order screen; don't jump back on top of it.
        _snoozed[next.id] = DateTime.now().add(incomingSnooze);
        final c = _navigatorKey.currentContext;
        if (c != null && c.mounted) GoRouter.of(c).push('/orders/${next.id}');
      }
      return true;
    } finally {
      _showing = null;
    }
  }
}
