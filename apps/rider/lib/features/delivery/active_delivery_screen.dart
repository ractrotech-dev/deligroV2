import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/action_queue.dart';
import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/geo.dart';
import '../../core/location_service.dart';
import '../../core/navigation_launcher.dart';
import '../../core/routing.dart';
import '../../models/jobs.dart';
import '../../state/clock.dart';
import '../../state/delivery.dart';
import '../../state/jobs.dart';
import '../../state/prefs.dart';
import '../../state/providers.dart';
import '../../theme/app_theme.dart';
import '../../widgets/common.dart' show TitleWithChip;
import '../jobs/offer_card.dart' show PaymentBanner;
import 'issue_sheets.dart';
import 'proof_photo.dart';
import '../safety/sos_sheet.dart' show SosButton;
import 'route_map.dart';
import 'step_tracker.dart';
import 'timeline.dart';

/// Inside this distance of the next stop the arrival button pulses.
const arrivalRadiusKm = 0.15;

/// A reading older than this is not sent with a step, nor used for "near".
const _fixFresh = Duration(minutes: 2);

/// An approximate route (the routing server was down) is not asked again
/// sooner than this, however far the rider strays from the straight line.
const _approxRetry = Duration(seconds: 30);

/// How long a Call tap waits for the contact log before dialling anyway.
const _contactWait = Duration(milliseconds: 1500);

const queuedNotice = "Saved — sends when you have signal";

/// A refused step, in words.
String actionErrorText(String? code, {String? method}) => switch (code) {
      'photo_required' => 'Take a proof photo first.',
      'manual_not_approved' => "Deligro ops haven't approved a manual check yet.",
      'bad_state' when method == 'ops_approved' => "Deligro ops haven't approved this yet.",
      'bad_state' => "That step doesn't match the delivery any more. Pull down to refresh.",
      'invalid_photo' => 'Retake the proof photo and try again.',
      'bad_type' || 'too_large' || 'invalid_body' => "The proof photo couldn't be used. Retake it and try again.",
      'invalid_position' => 'Your location looked wrong. Try again.',
      'migration_pending' => "This step isn't available yet. Call Deligro support.",
      _ => "That didn't go through. Try again.",
    };

enum _Tone { info, good, bad }

/// What came of sending the proof photo.
enum _Upload {
  /// The server has it.
  sent,

  /// Not sent (no signal, a server error): it goes with the step instead.
  later,

  /// The server will not take it (`bad_type`, `too_large`): retake.
  refused,

  /// There is no photo for this delivery.
  none,
}

/// The delivery the rider is carrying: one big action for where they are, and
/// everything they need at a gate with one hand — who, where, the codes, the
/// calls, the way there, and what to do when it goes wrong.
///
/// [active] is the board's delivery; [finished] keeps a delivery on screen
/// after it has left the board, so the rider sees how it ended.
class ActiveDeliveryScreen extends ConsumerStatefulWidget {
  const ActiveDeliveryScreen({
    super.key,
    required this.active,
    this.finished,
    this.fromCache = false,
    this.stale = false,
    this.routingBaseUrl,
  });

  final RiderActive? active;
  final FinishedDelivery? finished;

  /// Only the copy kept on the phone: the board could not be reached.
  final bool fromCache;

  /// The last board ask failed; what is shown may be old.
  final bool stale;
  final String? routingBaseUrl;

  @override
  ConsumerState<ActiveDeliveryScreen> createState() => _ActiveDeliveryScreenState();
}

class _ActiveDeliveryScreenState extends ConsumerState<ActiveDeliveryScreen> {
  bool _busy = false;

  /// Set before anything awaits: two taps in one frame make one step, not two.
  bool _sending = false;
  ({String text, _Tone tone})? _notice;

  /// Steps the server has applied that the board may not show yet.
  final _applied = <String, RiderDeliveryStatus>{};

  /// Steps saved for later by this screen: their answers come on the queue's
  /// outcome stream.
  final _waiting = <String, QueuedAction>{};
  StreamSubscription<ActionOutcome>? _outcomes;

  // The proof photo, for [_photoOrder].
  String? _photoOrder;
  File? _photo;
  String? _photoPath;
  ProofState _proof = ProofState.none;
  Future<_Upload>? _uploading;

  // The route to the next stop.
  RoutePlan? _plan;
  DateTime? _planAt;
  String? _planKey;
  bool _routing = false;

  /// "order:leg" pairs whose "you're near" banner the rider closed.
  final _nearSeen = <String>{};

  @override
  void initState() {
    super.initState();
    _outcomes = ref.read(actionQueueProvider).outcomes.listen(_onLaterOutcome);
  }

  @override
  void dispose() {
    _outcomes?.cancel();
    super.dispose();
  }

  DateTime _now() => ref.read(clockProvider)();

  BoardNotifier get _board => ref.read(boardProvider.notifier);

  RiderFix? _freshFix() {
    final f = ref.read(latestFixProvider);
    if (f == null || _now().difference(f.at) > _fixFresh) return null;
    return f;
  }

  /// The delivery on screen: the finished one while it is the same order the
  /// board shows (or the board shows none), else the board's.
  (RiderActive, FinishedDelivery?) _shown() {
    final board = widget.active;
    final done = widget.finished;
    if (done != null && (board == null || board.orderId == done.active.orderId)) {
      // Waiting for the queue's answer: still the live delivery on screen.
      if (done.waiting) return (board ?? done.active, null);
      return (done.active, done);
    }
    if (done != null) {
      // A new job: the old one's ending is no longer news.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) ref.read(finishedDeliveryProvider.notifier).clear();
      });
    }
    return (board!, null);
  }

  static RiderDeliveryStatus _statusFor(DeliveryEnd? end) => switch (end) {
        DeliveryEnd.delivered || DeliveryEnd.completedByOps => RiderDeliveryStatus.delivered,
        DeliveryEnd.failed => RiderDeliveryStatus.failed,
        DeliveryEnd.handedBack || DeliveryEnd.gone || null => RiderDeliveryStatus.cancelled,
      };

  void _say(String text, [_Tone tone = _Tone.info]) {
    if (mounted) setState(() => _notice = (text: text, tone: tone));
  }

  // ---------- Steps ----------

  /// Sends one step through the action queue. Returns the refusal in words,
  /// or null when it went through, was saved for later, or the order is gone.
  Future<String?> _step(
    RiderActive a,
    String action, {
    String? method,
    String? photoPath,
    String? localPhoto,
  }) async {
    if (_sending) return null;
    _sending = true;
    final fix = _freshFix();
    final q = QueuedAction.create(
      orderId: a.orderId,
      action: action,
      method: method,
      photoPath: photoPath,
      localPhoto: localPhoto,
      lat: fix?.lat,
      lng: fix?.lng,
      now: _now(),
    );
    setState(() {
      _busy = true;
      _notice = null;
    });
    final ActionOutcome out;
    try {
      out = await ref.read(actionQueueProvider).submit(q);
    } finally {
      _sending = false;
      if (mounted) setState(() => _busy = false);
    }
    if (!mounted) return null;
    return _settle(a, q, out);
  }

  String? _settle(RiderActive a, QueuedAction q, ActionOutcome out) {
    switch (out.kind) {
      case ActionOutcomeKind.applied:
      case ActionOutcomeKind.duplicate:
        setState(() => _applied[a.orderId] = actionTargets[q.action]!);
        if (q.action == 'deliver') {
          ref.read(finishedDeliveryProvider.notifier).finish(a, DeliveryEnd.delivered);
        }
        unawaited(_board.refresh(afterAction: true));
        return null;
      case ActionOutcomeKind.queued:
        _waiting[q.actionId] = q;
        _say(queuedNotice);
        return null;
      case ActionOutcomeKind.rejected:
        if (proofRefusals.contains(out.code) || out.code == 'invalid_photo') _dropPhoto();
        return actionErrorText(out.code, method: q.method);
      case ActionOutcomeKind.orderGone:
        ref.read(finishedDeliveryProvider.notifier).finish(a, DeliveryEnd.gone);
        return null;
    }
  }

  /// The answer to a step saved earlier, sent when the signal came back.
  void _onLaterOutcome(ActionOutcome out) {
    final q = _waiting.remove(out.actionId);
    if (q == null || !mounted) return;
    final shown = widget.active ?? widget.finished?.active;
    if (shown == null || shown.orderId != q.orderId) return;
    final error = _settle(shown, q, out);
    if (error != null) _say(error, _Tone.bad);
  }

  Future<void> _simpleStep(RiderActive a, String action, {String? method}) async {
    final error = await _step(a, action, method: method);
    if (error != null) _say(error, _Tone.bad);
  }

  /// "Delivered": no handover code (retired 2026-10-27); the proof photo
  /// still applies where the platform asks for one.
  Future<void> _delivered(RiderActive a) async {
    final error = await _deliver(a, method: 'code');
    if (error != null) _say(error, _Tone.bad);
  }

  /// The `deliver` step, with its proof photo where one is needed. With no
  /// signal for the photo the step is saved with a copy of it kept on the
  /// phone, and the queue sends both once the signal is back.
  Future<String?> _deliver(RiderActive a, {required String method}) async {
    if (!a.podPhotoRequired) return _step(a, 'deliver', method: method);
    switch (await _uploadProof(a)) {
      case _Upload.sent:
        return _step(a, 'deliver', method: method, photoPath: _photoPath);
      case _Upload.none:
        return 'Take a proof photo first.';
      case _Upload.refused:
        return actionErrorText('bad_type');
      case _Upload.later:
        break;
    }
    final file = _photo;
    if (file == null || !mounted) return null;
    final String kept;
    try {
      kept = await ref.read(proofKeeperProvider)(a.orderId, file);
    } catch (_) {
      return "Couldn't send the photo. Check your signal and try again.";
    }
    if (!mounted) return null;
    return _step(a, 'deliver', method: method, localPhoto: kept);
  }

  // ---------- Proof photo ----------

  Future<void> _takeProof(RiderActive a) async {
    final File? file;
    try {
      file = await ref.read(photoTakerProvider)();
    } catch (_) {
      _say("The camera didn't open. Try again.", _Tone.bad);
      return;
    }
    if (file == null || !mounted) return;
    setState(() {
      _photoOrder = a.orderId;
      _photo = file;
      _photoPath = null;
      _proof = ProofState.uploading;
    });
    await _uploadProof(a);
  }

  void _dropPhoto() {
    if (!mounted) return;
    setState(() {
      _photo = null;
      _photoPath = null;
      _proof = ProofState.none;
    });
  }

  /// Sends the photo taken for [a], or joins the send already going.
  /// [quiet]: a retry in the background (the board answering again), which
  /// leaves the tile and the code button as they are until it is through.
  Future<_Upload> _uploadProof(RiderActive a, {bool quiet = false}) {
    final running = _uploading;
    if (running != null) return running;
    final run = _sendProof(a, quiet: quiet);
    _uploading = run;
    run.whenComplete(() {
      if (identical(_uploading, run)) _uploading = null;
    });
    return run;
  }

  Future<_Upload> _sendProof(RiderActive a, {required bool quiet}) async {
    final file = _photo;
    if (file == null || _photoOrder != a.orderId) return _Upload.none;
    if (_photoPath != null) return _Upload.sent;
    if (!quiet) setState(() => _proof = ProofState.uploading);
    try {
      final path = await ref.read(jobsRepoProvider).uploadProof(a.orderId, file);
      if (!mounted || _photo != file) return _Upload.later;
      setState(() {
        _photoPath = path;
        _proof = ProofState.attached;
      });
      return _Upload.sent;
    } catch (e) {
      if (!mounted || _photo != file) return _Upload.later;
      if (e is ApiException && proofRefusals.contains(e.code)) {
        _dropPhoto();
        _say(actionErrorText(e.code), _Tone.bad);
        return _Upload.refused;
      }
      setState(() => _proof = ProofState.failed);
      return _Upload.later;
    }
  }

  /// "Photo not sent — it'll retry": each fresh board answer (the signal is
  /// back) tries the photo again, unless a saved `deliver` carries it.
  void _retryProof(BoardState next) {
    if (_proof != ProofState.failed || _photo == null || _photoPath != null) return;
    if (next.error != null || next.fromCache) return;
    final a = next.board?.active;
    if (a == null || a.orderId != _photoOrder) return;
    // Only while the photo is still needed: not once the delivery is done.
    if (a.status != RiderDeliveryStatus.arrivedDrop || _applied[a.orderId] != null) return;
    if (ref.read(finishedDeliveryProvider) != null) return;
    final carried = ref.read(actionQueueProvider).current.any((q) => q.orderId == a.orderId && q.localPhoto != null);
    if (!carried) unawaited(_uploadProof(a, quiet: true));
  }

  // ---------- Calls and navigation ----------

  Future<void> _call(RiderActive a, RiderStop stop, String target, RiderDeliveryStatus status) async {
    final uri = callUri(stop.phone);
    if (uri == null) return;
    // Logged first (customer unreachable rests on it), but never at the cost
    // of the call itself: a failure or a slow server just goes on to dial.
    try {
      await ref.read(jobsRepoProvider).logContact(a.orderId, target).timeout(_contactWait);
      if (target == 'customer' && status == RiderDeliveryStatus.arrivedDrop) {
        ref.read(customerCallsProvider.notifier).called(a.orderId, _now());
      }
    } catch (_) {}
    final opened = await ref.read(urlOpenerProvider)(uri);
    if (!opened) _say("Couldn't open the phone app. Call ${stop.phone}.", _Tone.bad);
  }

  Future<void> _navigate(RiderStop stop) async {
    final app = NavApp.parse(ref.read(riderPrefsProvider).navApp);
    final ok = await navigateTo(ref.read(urlOpenerProvider), app, stop);
    if (!ok) _say("Couldn't open a maps app.", _Tone.bad);
  }

  // ---------- Requests to ops ----------

  /// `arrivedDropAt` is the server's instant, so the wait is counted on the
  /// server's clock (the phone's plus the board's offset).
  UnreachableGate _gate(RiderActive a) =>
      unreachableGate(a, now: ref.read(serverClockProvider)(), localCall: ref.read(customerCallsProvider)[a.orderId]);

  Future<void> _issues(RiderActive a, String title, List<String> kinds) async {
    final wire = await showIssueMenu(
      context,
      title: title,
      kinds: kinds,
      unreachable: kinds.contains('customer_unreachable') ? () => _gate(a) : null,
    );
    if (wire == null || !mounted) return;
    await _raise(a, issueKind(wire));
  }

  Future<void> _raise(RiderActive a, IssueKind kind) async {
    final sent = await showIssueSheet(
      context,
      kind: kind,
      takePhoto: ref.read(photoTakerProvider),
      send: (d) => _sendIssue(a, kind.wire, d),
    );
    if (!sent || !mounted) return;
    _say('Sent to Deligro ops. Their answer shows here.', _Tone.good);
    unawaited(_board.refresh(afterAction: true));
  }

  Future<String?> _sendIssue(RiderActive a, String kind, IssueDraft d) async {
    final repo = ref.read(jobsRepoProvider);
    final fix = _freshFix();
    try {
      String? photoPath;
      final photo = d.photo;
      if (photo != null) {
        photoPath = await repo.uploadProof(a.orderId, photo);
        // The server keeps one photo per delivery: the proof must go again.
        if (mounted && _photoPath != null) {
          setState(() {
            _photoPath = null;
            _proof = ProofState.failed;
          });
        }
      }
      await repo.raiseException(
        orderId: a.orderId,
        kind: kind,
        reason: d.reason,
        notes: d.notes,
        photoPath: photoPath,
        lat: fix?.lat,
        lng: fix?.lng,
      );
      return null;
    } catch (e) {
      return issueErrorText(e);
    }
  }

  // ---------- Routing ----------

  void _route(LatLngPoint? from, LatLngPoint? to) {
    if (from == null || to == null) {
      _plan = null;
      _planKey = null;
      return;
    }
    final key = '${to.lat},${to.lng}';
    if (key != _planKey) {
      _plan = null;
      _planAt = null;
      _planKey = key;
    }
    if (_routing) return;
    final now = _now();
    final at = _planAt;
    if (_plan?.approx == true && at != null && now.difference(at) < _approxRetry) return;
    if (!needsReroute(plan: _plan, at: at, now: now, rider: from)) return;
    _routing = true;
    final base = widget.routingBaseUrl ?? defaultRoutingBaseUrl;
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      // Never waits on the screen: the map draws without it until it comes.
      final plan = await ref.read(routingClientProvider).route(base, from, to);
      if (!mounted) return;
      setState(() {
        _routing = false;
        if (_planKey == key) {
          _plan = plan;
          _planAt = _now();
        }
      });
    });
  }

  // ---------- Build ----------

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    ref.listen(boardProvider, (_, next) => _retryProof(next));
    final (a, done) = _shown();
    // The board has caught up with a step it applied: its word counts again
    // (ops may move a delivery back, and the screen must follow).
    final lifted = _applied[a.orderId];
    if (lifted != null && a.status.index >= lifted.index) _applied.remove(a.orderId);
    final waiting = (ref.watch(pendingActionsProvider).value ?? const <QueuedAction>[])
        .where((q) => q.orderId == a.orderId)
        .toList();
    final status = done != null ? _statusFor(done.end) : effectiveStatus(a, waiting, applied: _applied[a.orderId]);
    final live = status.live;
    final toShop = status.index <= RiderDeliveryStatus.arrivedPickup.index;
    final target = toShop ? a.shop : a.drop;

    ref.watch(latestFixProvider);
    ref.watch(customerCallsProvider);
    final fix = _freshFix();
    final rider = fix == null ? null : (lat: fix.lat, lng: fix.lng);
    final heading = status == RiderDeliveryStatus.accepted || status == RiderDeliveryStatus.onTheWay;
    final near = heading &&
        rider != null &&
        target.point != null &&
        haversineKm(rider.lat, rider.lng, target.point!.lat, target.point!.lng) <= arrivalRadiusKm;
    final nearKey = '${a.orderId}:${toShop ? 'shop' : 'drop'}';
    final showNearBanner = near && !_nearSeen.contains(nearKey);

    if (live) _route(rider ?? (toShop ? null : a.shop.point), target.point);
    if (_photoOrder != null && _photoOrder != a.orderId) {
      _photoOrder = null;
      _photo = null;
      _photoPath = null;
      _proof = ProofState.none;
    }

    final notice = _notice;
    return Column(
      key: const Key('active-delivery'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.fromCache)
          const _Strip(
            key: Key('offline-banner'),
            icon: Icons.cloud_off_rounded,
            text: 'No connection — showing saved details',
            strong: true,
          )
        else if (widget.stale)
          const _Strip(
            key: Key('delivery-stale'),
            icon: Icons.cloud_off_rounded,
            text: "Can't reach Deligro — details may be out of date",
          ),
        if (notice != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: _Notice(
              text: notice.text,
              tone: notice.tone,
              onClose: () => setState(() => _notice = null),
            ),
          ),
        if (waiting.isNotEmpty && done == null)
          _Strip(
            key: const Key('pending-steps'),
            icon: Icons.schedule_send_rounded,
            text: waiting.length == 1 ? '1 step waiting to send' : '${waiting.length} steps waiting to send',
          ),
        Expanded(
          // Not a lazy list: a dozen pieces, all of them wanted by a screen
          // reader and by "find the Call button" at once.
          child: SingleChildScrollView(
            key: const Key('delivery-scroll'),
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
              if (showNearBanner) ...[
                _NearBanner(
                  text: toShop ? "You're at the shop? Tap I've arrived at the shop." : "You're here? Tap I've arrived.",
                  onClose: () => setState(() => _nearSeen.add(nearKey)),
                ),
                const SizedBox(height: 10),
              ],
              _Header(code: a.code, onTimeline: () => showTimelineSheet(context, a)),
              const SizedBox(height: 10),
              if (!live) ...[
                _EndPanel(
                  active: a,
                  status: status,
                  end: done?.end,
                  unsent: waiting.any((q) => q.action == 'deliver'),
                ),
                const SizedBox(height: 12),
              ],
              if (done == null || done.end == DeliveryEnd.delivered || done.end == DeliveryEnd.completedByOps) ...[
                StepTracker(status: status),
                const SizedBox(height: 12),
              ],
              if (status == RiderDeliveryStatus.arrivedPickup) ...[
                const _PickupHint(),
                const SizedBox(height: 12),
              ],
              if (status == RiderDeliveryStatus.arrivedDrop) ...[
                _DropHint(photo: a.podPhotoRequired),
                const SizedBox(height: 12),
              ],
              if (live && (a.shop.point != null || a.drop.point != null || rider != null)) ...[
                RouteMap(shop: a.shop.point, drop: a.drop.point, rider: rider, plan: _plan, toShop: toShop),
                const SizedBox(height: 12),
              ],
              _StopCard(
                next: live,
                label: toShop ? 'PICK UP FROM' : 'DELIVER TO',
                stop: target,
                person: toShop ? null : a.drop.customerName,
                instructions: toShop ? null : a.instructions,
                instructionsUpdated: _instructionsChanged(a),
                // Not at a stop: there, "2 km · 3 min" is noise.
                eta: heading || status == RiderDeliveryStatus.pickedUp ? _etaText(a, toShop) : null,
                callKey: toShop ? 'call-shop' : 'call-customer',
                callLabel: toShop ? 'Call shop' : 'Call customer',
                onCall: live ? () => _call(a, target, toShop ? 'vendor' : 'customer', status) : null,
                onNavigate: live ? () => _navigate(target) : null,
              ),
              const SizedBox(height: 10),
              _StopCard(
                next: false,
                label: toShop ? 'THEN DELIVER TO' : 'PICKED UP FROM',
                stop: toShop ? a.drop : a.shop,
                person: toShop ? a.drop.customerName : null,
                instructions: toShop ? a.instructions : null,
                instructionsUpdated: _instructionsChanged(a),
                callKey: toShop ? 'call-customer' : 'call-shop',
                callLabel: toShop ? 'Call customer' : 'Call shop',
                onCall: live
                    ? () => _call(a, toShop ? a.drop : a.shop, toShop ? 'customer' : 'vendor', status)
                    : null,
              ),
              // Only while it is live: "Collect ₹485" on a failed or
              // cancelled order would send the rider asking for money.
              if (live) ...[
                const SizedBox(height: 10),
                PaymentBanner(payment: a.payment),
              ],
              if (a.items.isNotEmpty) ...[
                const SizedBox(height: 10),
                _Items(items: a.items),
              ],
              if (a.exceptions.isNotEmpty) ...[
                const SizedBox(height: 10),
                _Requests(exceptions: a.exceptions),
              ],
            ],
            ),
          ),
        ),
        _ActionBar(children: _actions(c, a, status, done, near)),
      ],
    );
  }

  /// The customer edited the instructions after the rider took the order.
  bool _instructionsChanged(RiderActive a) =>
      a.timeline.any((e) => e.kind == 'note' && e.method == 'instructions_changed');

  String? _etaText(RiderActive a, bool toShop) {
    final plan = _plan;
    if (plan != null) {
      return '${distance(plan.distanceKm)} · ${plan.etaMinutes} min${plan.approx ? ' approx.' : ''}';
    }
    if (toShop) return null;
    return [
      if (a.distanceKm != null) distance(a.distanceKm!),
      if (a.etaMinutes != null) 'ETA ${a.etaMinutes} min',
    ].join(' · ').ifEmpty;
  }


  List<Widget> _actions(AppColors c, RiderActive a, RiderDeliveryStatus status, FinishedDelivery? done, bool near) {
    Widget link(String key, String text, VoidCallback onTap, {IconData? icon}) => TextButton.icon(
          key: Key(key),
          onPressed: _busy ? null : onTap,
          style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
          icon: Icon(icon ?? Icons.report_gmailerrorred_rounded, size: 20),
          label: Text(text),
        );
    Widget links(List<Widget> items) => Wrap(alignment: WrapAlignment.center, spacing: 4, children: items);

    switch (status) {
      case RiderDeliveryStatus.accepted:
        return [
          _Primary(
            label: "I've arrived at the shop",
            icon: Icons.storefront_rounded,
            busy: _busy,
            pulse: near,
            onPressed: () => _simpleStep(a, 'arrive_pickup'),
          ),
          links([link('report-problem', 'Problem at the shop?', () => _issues(a, 'Problem at the shop?', shopIssues))]),
        ];
      case RiderDeliveryStatus.arrivedPickup:
        return [
          _Primary(
            label: 'Picked up',
            icon: Icons.shopping_bag_rounded,
            busy: _busy,
            onPressed: () => _simpleStep(a, 'pickup'),
          ),
          links([
            link('report-problem', 'Problem at the shop?', () => _issues(a, 'Problem at the shop?', shopIssues)),
          ]),
        ];
      case RiderDeliveryStatus.pickedUp:
        return [
          _Primary(
            label: 'Start trip',
            icon: Icons.two_wheeler_rounded,
            busy: _busy,
            onPressed: () => _simpleStep(a, 'start_trip'),
          ),
          links([link('report-problem', 'Report a problem', () => _issues(a, 'Report a problem', roadIssues))]),
        ];
      case RiderDeliveryStatus.onTheWay:
        return [
          _Primary(
            label: "I've arrived",
            icon: Icons.home_rounded,
            busy: _busy,
            pulse: near,
            onPressed: () => _simpleStep(a, 'arrive_drop'),
          ),
          links([link('report-problem', 'Report a problem', () => _issues(a, 'Report a problem', roadIssues))]),
        ];
      case RiderDeliveryStatus.arrivedDrop:
        final needsPhoto = a.podPhotoRequired;
        final photoReady = !needsPhoto || (_photo != null && _proof != ProofState.uploading);
        return [
          if (needsPhoto) ...[
            ProofPhotoTile(
              state: _proof,
              photo: _photo,
              enabled: !_busy,
              onTake: () => _takeProof(a),
            ),
            const SizedBox(height: 8),
          ],
          _Primary(
            label: 'Delivered',
            icon: Icons.check_circle_rounded,
            busy: _busy,
            onPressed: photoReady ? () => _delivered(a) : null,
          ),
          links([
            link('cant-deliver', "Can't deliver?", () => _issues(a, "Can't deliver?", dropIssues),
                icon: Icons.do_not_disturb_on_outlined),
          ]),
        ];
      case RiderDeliveryStatus.delivered:
      case RiderDeliveryStatus.failed:
      case RiderDeliveryStatus.cancelled:
        return [
          _Primary(
            label: 'Back to jobs',
            icon: Icons.arrow_forward_rounded,
            busy: false,
            onPressed: () {
              ref.read(finishedDeliveryProvider.notifier).clear();
              unawaited(_board.refresh(afterAction: true));
            },
          ),
        ];
    }
  }
}

extension on String {
  String? get ifEmpty => isEmpty ? null : this;
}

// ---------- Pieces ----------

/// The one big button. Pulses (gently, and only the button) when the rider is
/// at the stop it is about.
class _Primary extends StatelessWidget {
  const _Primary({required this.label, required this.icon, required this.busy, this.onPressed, this.pulse = false});

  final String label;
  final IconData icon;
  final bool busy;
  final bool pulse;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final button = FilledButton.icon(
      onPressed: busy ? null : onPressed,
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(60),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
        textStyle: Theme.of(context).filledButtonTheme.style?.textStyle?.resolve({})?.copyWith(fontSize: 18),
      ),
      icon: busy
          ? SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(strokeWidth: 3, color: context.colors.muted),
            )
          : Icon(icon, size: 24),
      label: Text(label, textAlign: TextAlign.center),
    );
    return KeyedSubtree(
      key: const Key('primary-action'),
      child: pulse ? _Pulse(key: const Key('primary-pulse'), child: button) : button,
    );
  }
}

class _Pulse extends StatefulWidget {
  const _Pulse({super.key, required this.child});

  final Widget child;

  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))
    ..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final accent = context.colors.accent;
    return AnimatedBuilder(
      animation: _c,
      builder: (context, child) => DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(radiusBlock),
          boxShadow: [
            BoxShadow(color: accent.withValues(alpha: .25 + .35 * _c.value), blurRadius: 6 + 12 * _c.value, spreadRadius: 1 + 3 * _c.value),
          ],
        ),
        child: child,
      ),
      child: widget.child,
    );
  }
}

class _ActionBar extends StatelessWidget {
  const _ActionBar({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      decoration: BoxDecoration(
        color: c.surface,
        border: Border(top: BorderSide(color: c.line)),
        boxShadow: const [BoxShadow(color: Color(0x14000000), blurRadius: 12, offset: Offset(0, -2))],
      ),
      padding: EdgeInsets.fromLTRB(16, 12, 16, 6 + MediaQuery.paddingOf(context).bottom),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.code, required this.onTimeline});

  final String code;
  final VoidCallback onTimeline;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Row(
      children: [
        Icon(Icons.two_wheeler_rounded, color: c.green, size: 26),
        const SizedBox(width: 8),
        Expanded(
          child: Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 10,
            children: [
              Text('Active delivery', style: Theme.of(context).textTheme.titleLarge),
              Text(code, style: dataStyle(context, size: 15).copyWith(color: c.muted)),
            ],
          ),
        ),
        TextButton.icon(
          key: const Key('timeline-button'),
          onPressed: onTimeline,
          icon: const Icon(Icons.history_rounded, size: 20),
          label: const Text('Timeline'),
        ),
        const SosButton(),
      ],
    );
  }
}

class _Strip extends StatelessWidget {
  const _Strip({super.key, required this.icon, required this.text, this.strong = false});

  final IconData icon;
  final String text;
  final bool strong;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final fg = strong ? c.popInk : c.ink;
    return Container(
      color: strong ? c.pop : c.surface2,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          Icon(icon, size: 20, color: fg),
          const SizedBox(width: 8),
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text(text, style: TextStyle(color: fg, fontWeight: FontWeight.w800, fontSize: 15)),
            ),
          ),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text, required this.tone, required this.onClose});

  final String text;
  final _Tone tone;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (bg, fg, icon) = switch (tone) {
      _Tone.bad => (c.dealSoft, c.deal, Icons.error_outline_rounded),
      _Tone.good => (c.greenSoft, c.green, Icons.check_circle_outline_rounded),
      _Tone.info => (c.surface2, c.ink, Icons.info_outline_rounded),
    };
    return Container(
      key: const Key('delivery-notice'),
      padding: const EdgeInsets.fromLTRB(14, 6, 4, 6),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(radiusBlock)),
      child: Row(
        children: [
          Icon(icon, color: fg, size: 22),
          const SizedBox(width: 10),
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text(text, style: TextStyle(color: fg, fontWeight: FontWeight.w700, fontSize: 15, height: 1.3)),
            ),
          ),
          IconButton(tooltip: 'Dismiss', onPressed: onClose, icon: Icon(Icons.close_rounded, color: fg)),
        ],
      ),
    );
  }
}

class _NearBanner extends StatelessWidget {
  const _NearBanner({required this.text, required this.onClose});

  final String text;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      key: const Key('near-banner'),
      padding: const EdgeInsets.fromLTRB(14, 6, 4, 6),
      decoration: BoxDecoration(
        color: c.accentSoft,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.accent, width: 1.5),
      ),
      child: Row(
        children: [
          Icon(Icons.near_me_rounded, color: c.accentInk),
          const SizedBox(width: 10),
          Expanded(
            child: Semantics(
              liveRegion: true,
              child: Text(text, style: TextStyle(color: c.accentInk, fontWeight: FontWeight.w800, fontSize: 15.5)),
            ),
          ),
          IconButton(
            key: const Key('near-banner-close'),
            tooltip: 'Dismiss',
            onPressed: onClose,
            icon: Icon(Icons.close_rounded, color: c.accentInk),
          ),
        ],
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.child, this.highlight = false});

  final Widget child;
  final bool highlight;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusSheet),
        border: Border.all(color: highlight ? c.ink : c.line, width: highlight ? 2 : 1),
      ),
      child: child,
    );
  }
}

class _PickupHint extends StatelessWidget {
  const _PickupHint();

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('At the shop', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text('Collect the order, then tap Picked up.', style: TextStyle(color: c.ink, fontSize: 15)),
          const SizedBox(height: 10),
          Row(
            children: [
              SizedBox(
                key: const Key('handover-spinner'),
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2.4, color: c.accent),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Or ask the shop to tap Handed to rider — this screen moves on by itself.',
                  style: TextStyle(color: c.muted, fontSize: 14, fontWeight: FontWeight.w600),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _DropHint extends StatelessWidget {
  const _DropHint({required this.photo});

  final bool photo;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('At the customer', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(
            photo
                ? 'Take a photo of the handover, then tap Delivered.'
                : 'Hand over the order, then tap Delivered.',
            style: TextStyle(color: c.ink, fontSize: 15),
          ),
        ],
      ),
    );
  }
}

class _EndPanel extends StatelessWidget {
  const _EndPanel({required this.active, required this.status, this.end, this.unsent = false});

  final RiderActive active;
  final RiderDeliveryStatus status;
  final DeliveryEnd? end;

  /// The deliver step is saved on the phone, not yet with the server.
  final bool unsent;

  String? _reason(String kind) => active.timeline.where((e) => e.kind == kind && (e.reason ?? '').isNotEmpty).lastOrNull?.reason;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final collect = active.payment.instruction == CashInstruction.collect
        ? ' Collected ${rupees(active.payment.collectAmount)} cash.'
        : '';
    final (icon, color, title, body) = switch ((status, end)) {
      (_, DeliveryEnd.gone) => (
          Icons.block_rounded,
          c.deal,
          'This order is no longer yours',
          'It was cancelled or given to another rider. If you have the food, call Deligro support.',
        ),
      (_, DeliveryEnd.handedBack) => (
          Icons.assignment_return_rounded,
          c.muted,
          'Handed back',
          'Deligro ops gave this order to another rider.',
        ),
      (_, DeliveryEnd.completedByOps) => (Icons.check_circle_rounded, c.green, 'Delivered', 'Deligro ops completed this delivery for you.$collect'),
      (RiderDeliveryStatus.delivered, _) when unsent => (
          Icons.schedule_send_rounded,
          c.accentInk,
          'Delivered — not sent yet',
          "Saved on your phone. It goes to Deligro as soon as you have signal.$collect",
        ),
      (RiderDeliveryStatus.delivered, _) => (Icons.check_circle_rounded, c.green, 'Delivered', 'Nice work.$collect'),
      (RiderDeliveryStatus.failed, _) => (
          Icons.cancel_rounded,
          c.deal,
          'Delivery failed',
          '${_reason('failed') == null ? '' : '${_reason('failed')}. '}Take the food back to the shop.',
        ),
      _ => (
          Icons.cancel_rounded,
          c.deal,
          'Order cancelled',
          '${_reason('cancelled') == null ? '' : '${_reason('cancelled')}. '}If you already have the food, call Deligro support.',
        ),
    };
    return Container(
      key: const Key('delivery-end'),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusSheet),
        border: Border.all(color: color, width: 2.5),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 34),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(liveRegion: true, child: Text(title, style: Theme.of(context).textTheme.titleLarge)),
                const SizedBox(height: 4),
                Text(body, style: TextStyle(color: c.ink, fontSize: 15)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A stop: who and where, and for the next stop the way there and a call.
class _StopCard extends StatelessWidget {
  const _StopCard({
    required this.next,
    required this.label,
    required this.stop,
    required this.callKey,
    required this.callLabel,
    this.person,
    this.instructions,
    this.instructionsUpdated = false,
    this.eta,
    this.onCall,
    this.onNavigate,
  });

  final bool next;
  final String label;
  final RiderStop stop;
  final String? person;
  final String? instructions;

  /// The customer changed the instructions while the rider had the order
  /// (a `note` / `instructions_changed` event): shown highlighted.
  final bool instructionsUpdated;
  final String? eta;
  final String callKey;
  final String callLabel;
  final VoidCallback? onCall;
  final VoidCallback? onNavigate;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final hasPhone = (stop.phone ?? '').trim().isNotEmpty;
    final title = person?.trim().isNotEmpty == true ? person! : stop.name;
    return _Card(
      highlight: next,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              if (eta == null)
                Expanded(child: Text(label, style: Theme.of(context).textTheme.labelSmall))
              else
                Text(label, style: Theme.of(context).textTheme.labelSmall),
              if (eta != null) ...[
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    eta!,
                    textAlign: TextAlign.right,
                    style: dataStyle(context, size: 13.5).copyWith(color: c.accentInk),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 4),
          Text(title, style: next ? Theme.of(context).textTheme.titleLarge : Theme.of(context).textTheme.titleMedium),
          if ((stop.line ?? '').isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(stop.line!, style: TextStyle(color: next ? c.ink : c.muted, fontSize: next ? 16 : 14.5)),
            ),
          if ((instructions ?? '').trim().isNotEmpty)
            Container(
              margin: const EdgeInsets.only(top: 10),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              decoration: BoxDecoration(
                color: instructionsUpdated ? c.pop : c.surface2,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                key: instructionsUpdated ? const Key('instructions-updated') : null,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.sticky_note_2_outlined, size: 18, color: instructionsUpdated ? c.popInk : c.muted),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (instructionsUpdated)
                          Text(
                            'Customer changed these',
                            style: TextStyle(color: c.popInk, fontWeight: FontWeight.w800, fontSize: 12.5),
                          ),
                        Text(
                          instructions!.trim(),
                          style: TextStyle(color: instructionsUpdated ? c.popInk : c.ink, fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          if (onNavigate != null || (onCall != null && hasPhone)) ...[
            const SizedBox(height: 12),
            Row(
              children: [
                if (onNavigate != null)
                  Expanded(
                    child: FilledButton.tonalIcon(
                      key: const Key('navigate'),
                      onPressed: onNavigate,
                      style: FilledButton.styleFrom(
                        minimumSize: const Size.fromHeight(50),
                        backgroundColor: c.ink,
                        foregroundColor: c.bg,
                      ),
                      icon: const Icon(Icons.navigation_rounded),
                      label: const Text('Navigate'),
                    ),
                  ),
                if (onNavigate != null && onCall != null && hasPhone) const SizedBox(width: 10),
                if (onCall != null && hasPhone)
                  Expanded(
                    child: OutlinedButton.icon(
                      key: Key(callKey),
                      onPressed: onCall,
                      style: OutlinedButton.styleFrom(minimumSize: const Size.fromHeight(50)),
                      icon: Icon(Icons.call_rounded, color: c.green),
                      label: Text('Call', semanticsLabel: callLabel),
                    ),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _Items extends StatelessWidget {
  const _Items({required this.items});

  final List<RiderItem> items;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final count = items.fold<int>(0, (n, i) => n + i.qty);
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('ITEMS · $count', style: Theme.of(context).textTheme.labelSmall),
          const SizedBox(height: 6),
          for (final i in items)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(
                children: [
                  Expanded(child: Text(i.name, style: TextStyle(color: c.ink, fontSize: 15, fontWeight: FontWeight.w600))),
                  const SizedBox(width: 8),
                  Text('× ${i.qty}', style: dataStyle(context, size: 15, weight: FontWeight.w800)),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _Requests extends StatelessWidget {
  const _Requests({required this.exceptions});

  final List<RiderException> exceptions;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final list = [...exceptions]..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('YOUR REQUESTS TO DELIGRO OPS', style: Theme.of(context).textTheme.labelSmall),
          for (final e in list)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TitleWithChip(
                    title: Text(_title(e.kind), style: TextStyle(color: c.ink, fontWeight: FontWeight.w800, fontSize: 15)),
                    chip: _StatusChip(status: e.status),
                  ),
                  if (e.reason.isNotEmpty) Text(e.reason, style: TextStyle(color: c.muted, fontSize: 14)),
                  if ((e.decisionNote ?? '').isNotEmpty)
                    Text('Deligro ops: ${e.decisionNote}', style: TextStyle(color: c.ink, fontSize: 14, fontWeight: FontWeight.w600)),
                ],
              ),
            ),
        ],
      ),
    );
  }

  static String _title(String kind) {
    try {
      return issueKind(kind).title;
    } catch (_) {
      final words = kind.replaceAll('_', ' ');
      return words.isEmpty ? 'Request' : words[0].toUpperCase() + words.substring(1);
    }
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.status});

  final String status;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (bg, fg) = switch (status) {
      'pending' => (c.pop, c.popInk),
      'approved' => (c.greenSoft, c.green),
      'rejected' => (c.dealSoft, c.deal),
      _ => (c.surface2, c.muted),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (status == 'pending') ...[
            SizedBox(width: 10, height: 10, child: CircularProgressIndicator(strokeWidth: 1.6, color: fg)),
            const SizedBox(width: 5),
          ],
          Flexible(
            child: Text(issueStatusText(status), style: TextStyle(color: fg, fontWeight: FontWeight.w800, fontSize: 12.5)),
          ),
        ],
      ),
    );
  }
}
