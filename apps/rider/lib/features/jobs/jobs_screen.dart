import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../models/jobs.dart';
import '../../state/availability.dart';
import '../../state/clock.dart';
import '../../state/delivery.dart';
import '../../state/jobs.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../delivery/active_delivery_screen.dart';
import '../home/availability_actions.dart';
import '../home/availability_card.dart';
import 'offer_card.dart';
import 'offer_errors.dart';
import 'reject_sheet.dart';

/// The Jobs tab's route (`/jobs`); a tap on a push lands here.
const jobsPath = '/jobs';

final jobsRoute = GoRoute(path: jobsPath, builder: (_, _) => const JobsScreen());

/// How often the board is asked again while the tab is showing.
const jobsPollEvery = Duration(seconds: 5);

/// The Jobs tab: what the rider is carrying, or the offers waiting for them.
///
/// The board is asked again every 5 s while this tab is showing and the app is
/// in front, and at once when the rider comes back. Offers count down against
/// the phone's clock to the `offerExpiresAt` the board sent; at zero the card
/// turns into "Open to everyone" and the next board decides if it stays.
class JobsScreen extends ConsumerStatefulWidget {
  const JobsScreen({super.key});

  @override
  ConsumerState<JobsScreen> createState() => _JobsScreenState();
}

class _JobsScreenState extends ConsumerState<JobsScreen> with WidgetsBindingObserver {
  Timer? _poll;
  Timer? _clockTick;
  bool _tabShowing = true;
  bool _appInFront = true;

  /// The offer an answer is on its way for; the other buttons wait too.
  String? _answering;

  /// The last refusal, in words, until the next action or the rider closes it.
  String? _notice;
  bool _noticeOpensProfile = false;

  bool get _running => _tabShowing && _appInFront;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // An indexed stack keeps every tab alive and turns the tickers of those
    // that are not showing off. That is the signal: no polling out of sight.
    final showing = TickerMode.valuesOf(context).enabled;
    final changed = showing != _tabShowing;
    _tabShowing = showing;
    if (changed && showing) _board.refresh();
    _sync();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _clockTick?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final front = state == AppLifecycleState.resumed;
    if (front == _appInFront) return;
    _appInFront = front;
    if (front && _tabShowing) _board.refresh();
    _sync();
  }

  BoardNotifier get _board => ref.read(boardProvider.notifier);

  DateTime get _clockNow => ref.read(clockProvider)();

  void _sync() {
    if (_running) {
      _poll ??= Timer.periodic(jobsPollEvery, (_) => _board.refresh());
      // The countdown redraws every second, including the one that crosses zero.
      _clockTick ??= Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else {
      _poll?.cancel();
      _poll = null;
      _clockTick?.cancel();
      _clockTick = null;
    }
  }

  Future<void> _accept(RiderOffer offer) async {
    if (_answering != null) return;
    setState(() {
      _answering = offer.orderId;
      _notice = null;
    });
    try {
      await _board.accept(offer.orderId);
    } catch (e) {
      if (mounted) {
        setState(() {
          _notice = offerError(e);
          _noticeOpensProfile = offerErrorOpensProfile(e);
        });
      }
    } finally {
      if (mounted) setState(() => _answering = null);
    }
  }

  Future<void> _reject(RiderOffer offer) async {
    if (_answering != null) return;
    final choice = await showRejectSheet(context);
    if (choice == null || !mounted) return;
    setState(() {
      _answering = offer.orderId;
      _notice = null;
    });
    try {
      await _board.reject(offer.orderId, choice.reason.wire, note: choice.note);
    } catch (e) {
      if (mounted) {
        setState(() {
          _notice = offerError(e);
          _noticeOpensProfile = offerErrorOpensProfile(e);
        });
      }
    } finally {
      if (mounted) setState(() => _answering = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(boardProvider);
    final board = state.board;
    final finished = ref.watch(finishedDeliveryProvider);
    final offline = phaseOf(ref.watch(availabilityProvider), _clockNow) == RiderPhase.offline;

    final Widget body;
    if (board == null) {
      body = state.loading
          ? const Center(child: CircularProgressIndicator())
          : ErrorRetry(error: state.error!, onRetry: () => _board.refresh());
    } else if (board.active != null || finished != null) {
      body = ActiveDeliveryScreen(
        active: board.active,
        finished: finished,
        fromCache: state.fromCache,
        stale: state.stale,
        routingBaseUrl: board.routingBaseUrl,
      );
    } else if (offline) {
      body = _scroll(const _OfflineState());
    } else if (board.offers.isEmpty && board.upcoming.isEmpty) {
      body = _scroll(
        Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (state.stale) const _StaleStrip(),
            const EmptyState(
              icon: Icons.two_wheeler_rounded,
              title: 'No orders right now',
              body: 'New orders show up here and ring your phone.',
            ),
          ],
        ),
      );
    } else {
      body = _list(_offerChildren(state, board));
    }

    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
              child: Text('Jobs', style: Theme.of(context).textTheme.headlineSmall),
            ),
            // Outside the scrolling list: the rider has scrolled to the button
            // they pressed, and the answer must be where they are looking.
            if (_notice != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: _Notice(
                  text: _notice!,
                  onClose: () => setState(() => _notice = null),
                  actionLabel: _noticeOpensProfile ? 'Open Profile & documents' : null,
                  onAction: _noticeOpensProfile ? () => context.go('/more/profile/documents') : null,
                ),
              ),
            Expanded(
              child: RefreshIndicator(onRefresh: () => _board.refresh(), child: body),
            ),
          ],
        ),
      ),
    );
  }

  Widget _list(List<Widget> children) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        ...children,
      ],
    );
  }

  /// A centred state that can still be pulled to refresh.
  Widget _scroll(Widget child) => CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverFillRemaining(
            hasScrollBody: false,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                child,
              ],
            ),
          ),
        ],
      );

  List<Widget> _offerChildren(BoardState state, RiderBoard board) {
    final now = _clockNow;
    final onBreak = phaseOf(ref.read(availabilityProvider), now) == RiderPhase.onBreak;
    final busy = _answering != null;
    return [
      if (state.stale) const _StaleStrip(),
      if (onBreak) const _BreakStrip(),
      for (var i = 0; i < board.offers.length; i++) ...[
        if (i > 0) const SizedBox(height: 12),
        if (i == 0)
          OfferCard(
            offer: board.offers[i],
            now: now,
            windowSeconds: board.offerWindowSeconds,
            busy: busy,
            onAccept: () => _accept(board.offers[i]),
            onReject: () => _reject(board.offers[i]),
          )
        else
          OfferRow(
            offer: board.offers[i],
            now: now,
            busy: busy,
            onAccept: () => _accept(board.offers[i]),
            onReject: () => _reject(board.offers[i]),
          ),
      ],
      if (board.upcoming.isNotEmpty) ...[
        const SectionTitle('Upcoming pickups', padding: EdgeInsets.fromLTRB(2, 24, 2, 10)),
        for (var i = 0; i < board.upcoming.length; i++) ...[
          if (i > 0) const SizedBox(height: 10),
          UpcomingRow(upcoming: board.upcoming[i]),
        ],
      ],
    ];
  }
}

/// The last refusal, where the rider is looking, until they close it.
class _Notice extends StatelessWidget {
  const _Notice({required this.text, required this.onClose, this.actionLabel, this.onAction});

  final String text;
  final VoidCallback onClose;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        key: const Key('jobs-notice'),
        padding: const EdgeInsets.fromLTRB(14, 6, 4, 6),
        decoration: BoxDecoration(color: c.dealSoft, borderRadius: BorderRadius.circular(radiusBlock)),
        child: Row(
          children: [
            Icon(Icons.info_outline_rounded, color: c.deal, size: 22),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Semantics(
                    liveRegion: true,
                    child: Text(text, style: TextStyle(color: c.deal, fontWeight: FontWeight.w700, fontSize: 15, height: 1.3)),
                  ),
                  if (actionLabel != null)
                    TextButton(
                      key: const Key('jobs-notice-action'),
                      style: TextButton.styleFrom(padding: EdgeInsets.zero, minimumSize: const Size(48, 40), alignment: Alignment.centerLeft),
                      onPressed: onAction,
                      child: Text(actionLabel!),
                    ),
                ],
              ),
            ),
            IconButton(
              tooltip: 'Dismiss',
              onPressed: onClose,
              icon: Icon(Icons.close_rounded, color: c.deal),
            ),
          ],
        ),
      ),
    );
  }
}

/// The latest ask did not get through; what is on screen may be old.
class _StaleStrip extends StatelessWidget {
  const _StaleStrip();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        key: const Key('jobs-stale'),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(color: c.pop, borderRadius: BorderRadius.circular(12)),
        child: Row(
          children: [
            Icon(Icons.cloud_off_rounded, size: 18, color: c.popInk),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                "Can't reach Deligro — showing your last orders",
                style: TextStyle(color: c.popInk, fontWeight: FontWeight.w700, fontSize: 14),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BreakStrip extends StatelessWidget {
  const _BreakStrip();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(color: c.surface2, borderRadius: BorderRadius.circular(12)),
        child: Row(
          children: [
            Icon(Icons.pause_circle_rounded, size: 18, color: c.muted),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                "You're on a break. No new orders until you resume.",
                style: TextStyle(color: c.ink, fontWeight: FontWeight.w600, fontSize: 14),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A rider who is not online gets no orders: say so, and put the switch right
/// here, the same one as on Home.
class _OfflineState extends ConsumerStatefulWidget {
  const _OfflineState();

  @override
  ConsumerState<_OfflineState> createState() => _OfflineStateState();
}

class _OfflineStateState extends ConsumerState<_OfflineState> with AvailabilityActions<_OfflineState> {
  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 72,
            height: 72,
            decoration: BoxDecoration(color: c.surface2, shape: BoxShape.circle),
            child: Icon(Icons.power_settings_new_rounded, size: 34, color: c.muted),
          ),
          const SizedBox(height: 16),
          Semantics(
            liveRegion: true,
            child: Text(
              "You're offline — go online to get orders",
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleLarge,
            ),
          ),
          const SizedBox(height: 22),
          AvailabilitySwitch(
            online: false,
            busy: busy,
            onChanged: () => run(goOnline),
          ),
        ],
      ),
    );
  }
}
