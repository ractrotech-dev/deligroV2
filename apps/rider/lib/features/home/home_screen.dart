import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/ist_time.dart';
import '../../core/money.dart' show istDayKey;
import '../../models/dashboard.dart';
import '../../models/rider_me.dart';
import '../../state/availability.dart';
import '../../state/clock.dart';
import '../../state/insights.dart';
import '../../state/providers.dart';
import '../../state/support.dart' show inboxProvider;
import '../../theme/app_theme.dart';
import '../../widgets/common.dart';
import '../../state/cash.dart';
import '../cash/cash_strip.dart';
import '../profile/profile_widgets.dart' show VerificationBadge;
import '../earnings/earnings_widgets.dart' show earningsFeature;
import '../history/history_filters.dart';
import '../history/history_screen.dart' show historyLink;
import '../../widgets/rows.dart' show RowsCard;
import '../notifications/notifications_screen.dart' show NotificationBell;
import '../safety/safety_screen.dart' show SafetyRow;
import '../safety/stale_sos_banner.dart';
import 'availability_card.dart';
import 'current_delivery_card.dart';
import 'dashboard_grid.dart';

/// How often Home asks for its figures again while it is showing.
const dashboardPollEvery = Duration(seconds: 15);

/// The `driver.history` switch in `/api/rider/me`'s `features`.
const _historyFeature = 'driver.history';

/// The rider's home: who they are, then the twelve figures: the availability
/// card, the delivery in hand, today's counts, the money from the recorded
/// ledger and the incentive target. Asked again every 15 s while it shows, when
/// the app comes back to the front, and after an availability action.
class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});

  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen>
    with WidgetsBindingObserver {
  Timer? _poll;
  bool _tabShowing = true;
  late bool _appInFront;

  /// `/api/rider/me` had answered when the screen last built: the availability
  /// first appearing from it is not an action.
  bool _meReady = false;

  bool get _running => _tabShowing && _appInFront;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    final life = WidgetsBinding.instance.lifecycleState;
    _appInFront = life == null || life == AppLifecycleState.resumed;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // An indexed stack keeps every tab alive and turns the tickers of those
    // that are not showing off. That is the signal: no polling out of sight.
    final showing = TickerMode.valuesOf(context).enabled;
    final changed = showing != _tabShowing;
    _tabShowing = showing;
    if (changed && showing) _refresh(cash: true);
    _sync();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final front = state == AppLifecycleState.resumed;
    if (front == _appInFront) return;
    _appInFront = front;
    if (front && _tabShowing) _refresh(cash: true);
    _sync();
  }

  void _sync() {
    if (_running) {
      _poll ??= Timer.periodic(dashboardPollEvery, (_) => _refresh());
    } else {
      _poll?.cancel();
      _poll = null;
    }
  }

  /// The rider id Home last read figures for.
  String? _seenFor;

  AsyncValue<RiderDashboard> _watchDashboard(String id) {
    final provider = dashboardProvider(id);
    if (_seenFor != id) {
      _seenFor = id;
      // A provider left from an earlier visit (a rider who signed out and
      // back in during one app session) still holds that visit's figures:
      // ask again at once rather than wait for the first 15 s tick.
      if (ref.exists(provider)) {
        WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
      }
    }
    return ref.watch(provider);
  }

  /// The signed-in rider's id once `/api/rider/me` has answered. Every figure
  /// is read for this id and no other.
  String? get _riderId => ref.read(currentMeProvider)?.id;

  /// [cash]: also ask for the cash summary again (the strip under the
  /// availability card). Only when Home comes back into view, not on the
  /// 15 s tick, which is the dashboard's alone.
  void _refresh({bool cash = false}) {
    if (!mounted) return;
    if (cash) ref.invalidate(cashSummaryProvider);
    final id = _riderId;
    if (id != null) ref.invalidate(dashboardProvider(id));
  }

  Future<void> _pull() async {
    ref.invalidate(meProvider);
    ref.invalidate(cashSummaryProvider);
    ref.invalidate(inboxProvider);
    final id = _riderId;
    if (id == null) return;
    ref.invalidate(dashboardProvider(id));
    // A failed refresh is the offline banner's business, not an error here.
    await ref
        .read(dashboardProvider(id).future)
        .then<void>((_) {}, onError: (_) {});
  }

  @override
  Widget build(BuildContext context) {
    // After an action: the rider going online, offline or on a break changes
    // the figures at once.
    ref.listen(availabilityProvider, (prev, next) {
      if (_meReady && prev != null && prev != next) _refresh();
    });
    // Another rider on this phone: the last one's figures are dropped.
    ref.listen(currentMeProvider.select((m) => m?.id), (prev, next) {
      if (prev != null && prev != next) ref.invalidate(dashboardProvider(prev));
    });
    // Only the signed-in rider's own answer: while another user's loads, or
    // after it failed, nothing of the last rider's shows.
    final me = ref.watch(currentMeProvider);
    _meReady = me != null;
    final dash = me == null
        ? const AsyncValue<RiderDashboard>.loading()
        : _watchDashboard(me.id);
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: _pull,
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
            children: [
              if (me != null) _RiderHeader(me: me),
              const SizedBox(height: 16),
              const AvailabilityCard(),
              const StaleSosBanner(),
              const SizedBox(height: 12),
              const RowsCard(children: [SafetyRow()]),
              const CashInHandStrip(),
              const SizedBox(height: 12),
              ..._figures(context, me, dash),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _figures(
    BuildContext context,
    RiderMe? me,
    AsyncValue<RiderDashboard> dash,
  ) {
    final c = context.colors;
    final d = dash.value;
    if (d == null) {
      if (dash.hasError) {
        return [
          Panel(
            child: Column(
              children: [
                Text(
                  "Couldn't load today's figures",
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 4),
                Text(
                  'Check your connection and try again.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: c.muted),
                ),
                const SizedBox(height: 12),
                OutlinedButton(
                  key: const Key('dashboard-retry'),
                  onPressed: _refresh,
                  child: const Text('Try again'),
                ),
              ],
            ),
          ),
        ];
      }
      return [
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 32),
          child: Center(child: CircularProgressIndicator()),
        ),
      ];
    }
    final money = me?.feature(earningsFeature) == false ? null : d.money;
    final historyOn = me?.feature(_historyFeature) ?? true;
    return [
      CurrentDeliveryCard(current: d.current, onTap: () => context.go('/jobs')),
      const SizedBox(height: 16),
      CountGrid(
        today: d.today,
        toJobs: () => context.go('/jobs'),
        toHistory: historyOn
            ? (outcome) => context.go(
                historyLink(range: HistoryRange.today, outcome: outcome),
              )
            : null,
      ),
      if (money != null) ...[
        const SizedBox(height: 16),
        MoneyRow(figures: money),
        const SizedBox(height: 12),
        IncentivesCard(
          earned: money.incentivesThisWeek,
          target: d.nearestTarget,
        ),
      ],
      const SizedBox(height: 14),
      _UpdatedLine(
        at: d.updatedAt,
        now: ref.read(clockProvider)(),
        stale: dash.hasError,
      ),
    ];
  }
}

class _UpdatedLine extends StatelessWidget {
  const _UpdatedLine({
    required this.at,
    required this.now,
    required this.stale,
  });

  final DateTime? at;

  /// The phone's clock, to tell figures from another day.
  final DateTime now;
  final bool stale;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final style = TextStyle(
      color: c.muted,
      fontSize: 12.5,
      fontWeight: FontWeight.w600,
    );
    return Column(
      children: [
        if (at != null)
          Text(
            // Figures from an earlier day say which day.
            'Updated ${istDayKey(at!) == istDayKey(now) ? istClock(at!) : istDayTime(at!)}',
            textAlign: TextAlign.center,
            style: style,
          ),
        if (stale)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              "Couldn't refresh just now. Showing the last figures.",
              key: const Key('dashboard-stale'),
              textAlign: TextAlign.center,
              style: style.copyWith(color: c.deal),
            ),
          ),
      ],
    );
  }
}

class _RiderHeader extends StatelessWidget {
  const _RiderHeader({required this.me});

  final RiderMe me;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final name = (me.name ?? '').trim();
    final initial = name.isEmpty ? '' : name.characters.first.toUpperCase();
    return Row(
      children: [
        SizedBox(
          width: 52,
          height: 52,
          child: NetImage(
            url: me.avatarUrl,
            radius: 26,
            fallback: Text(
              initial,
              style: TextStyle(
                color: c.onAccent,
                fontSize: 22,
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (name.isNotEmpty)
                Text(
                  name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              if (me.riderCode != null) ...[
                const SizedBox(height: 4),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: c.surface2,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                    me.riderCode!,
                    style: dataStyle(context, size: 13),
                  ),
                ),
              ],
              if (me.profile != null) ...[
                const SizedBox(height: 6),
                InkWell(
                  key: const Key('verification-badge'),
                  borderRadius: BorderRadius.circular(8),
                  onTap: () => context.go('/more/profile'),
                  child: VerificationBadge(me.profile!.verification),
                ),
              ],
            ],
          ),
        ),
        const NotificationBell(),
      ],
    );
  }
}
