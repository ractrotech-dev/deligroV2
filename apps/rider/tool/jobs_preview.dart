// A debug-only way to see the Jobs tab on a phone or emulator without a server
// or a signed-in rider: the real screen and theme over the fixture backend.
//
//   flutter run -t tool/jobs_preview.dart --dart-define=FIXTURES=true
//     [--dart-define=FIXTURE_SCENARIO=offers|idle|full|accepted|...]
//     [--dart-define=PREVIEW_OFFLINE=true]   the rider is offline
//     [--dart-define=PREVIEW_DARK=true]
//     [--dart-define=PREVIEW_FIX=21.7187,81.5302]   where the rider "is" (the
//         delivery map and the "you're near" banner); no location service runs
//     [--dart-define=PREVIEW_NO_SIGNAL=true]   the board and every step fail as
//         with no connection: the delivery kept on the phone is shown, and
//         steps are saved for later
//
// The faint dot in the top-left corner (over the status bar) opens a picker
// that switches all of these without a rebuild: one install, every screen.
//
// Not part of the app: nothing imports this file, and a release build refuses
// the fixture backend anyway.
import 'dart:async';
import 'dart:io';

import 'package:deligro_rider/core/active_cache.dart';
import 'package:deligro_rider/core/api.dart';
import 'package:deligro_rider/core/location_service.dart';
import 'package:deligro_rider/core/ring.dart';
import 'package:deligro_rider/data/fixtures/fixture_backend.dart';
import 'package:deligro_rider/data/jobs_repository.dart';
import 'package:deligro_rider/features/jobs/jobs_screen.dart';
import 'package:deligro_rider/models/jobs.dart';
import 'package:deligro_rider/models/queued_action.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:deligro_rider/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Where the rider "is", by name.
const _fixes = <String, ({double lat, double lng})?>{
  'none': null,
  'near shop': (lat: 21.7183, lng: 81.5303),
  'on the road': (lat: 21.7150, lng: 81.5352),
  'near drop': (lat: 21.7107, lng: 81.5395),
};

class _Config {
  const _Config({
    required this.scenario,
    this.offline = false,
    this.dark = false,
    this.noSignal = false,
    this.fix,
  });

  final String scenario;
  final bool offline;
  final bool dark;
  final bool noSignal;
  final ({double lat, double lng})? fix;

  _Config copyWith({String? scenario, bool? offline, bool? dark, bool? noSignal, Object? fix = _keep}) => _Config(
        scenario: scenario ?? this.scenario,
        offline: offline ?? this.offline,
        dark: dark ?? this.dark,
        noSignal: noSignal ?? this.noSignal,
        fix: identical(fix, _keep) ? this.fix : fix as ({double lat, double lng})?,
      );
}

const _keep = Object();

_Config _fromDefines() {
  const fix = String.fromEnvironment('PREVIEW_FIX');
  final parts = fix.split(',').map((s) => double.tryParse(s.trim())).toList();
  return _Config(
    scenario: fixtureScenario,
    offline: const bool.fromEnvironment('PREVIEW_OFFLINE'),
    dark: const bool.fromEnvironment('PREVIEW_DARK'),
    noSignal: const bool.fromEnvironment('PREVIEW_NO_SIGNAL'),
    fix: parts.length == 2 && parts[0] != null && parts[1] != null ? (lat: parts[0]!, lng: parts[1]!) : null,
  );
}

/// The fixture backend with no connection: the board and the steps fail as a
/// phone with no signal would.
class _NoSignal implements JobsRepository {
  _NoSignal(this._inner);

  final JobsRepository _inner;

  static ApiException get _down => ApiException(0, 'network');

  @override
  Future<RiderBoard> board() async => throw _down;

  @override
  Future<ActionOutcome> act(QueuedAction a) async => throw _down;

  @override
  Future<void> accept(String orderId) => _inner.accept(orderId);

  @override
  Future<void> reject(String orderId, String reason, {String? note}) => _inner.reject(orderId, reason, note: note);

  @override
  Future<String> uploadProof(String orderId, File photo) async => throw _down;

  @override
  Future<void> logContact(String orderId, String target) async => throw _down;

  @override
  Future<String> raiseException({
    required String orderId,
    required String kind,
    required String reason,
    String? notes,
    String? photoPath,
    double? lat,
    double? lng,
  }) async =>
      throw _down;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  if (!fixturesEnabled) {
    throw StateError('run with --dart-define=FIXTURES=true in a debug or profile build');
  }
  final prefs = await SharedPreferences.getInstance();
  runApp(_Preview(prefs: prefs, initial: _fromDefines()));
}

class _Preview extends StatefulWidget {
  const _Preview({required this.prefs, required this.initial});

  final SharedPreferences prefs;
  final _Config initial;

  @override
  State<_Preview> createState() => _PreviewState();
}

class _PreviewState extends State<_Preview> {
  late _Config _config = widget.initial;
  ProviderContainer? _container;
  Key _key = UniqueKey();
  Timer? _fixTimer;
  final _navigator = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _fixTimer?.cancel();
    _container?.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final cfg = _config;
    final prefs = widget.prefs;
    // A clean phone each time: no steps or delivery left from before.
    await prefs.remove('action_queue_v1');
    await prefs.remove(ActiveDeliveryCache.key);
    final now = DateTime.now();
    final fixture = FixtureJobsRepository.create(scenario: cfg.scenario, now: now);
    if (cfg.noSignal) {
      final kept = (await fixture.board()).active;
      if (kept != null) await ActiveDeliveryCache(prefs).save(kept);
    }
    final container = ProviderContainer(
      overrides: [
        prefsProvider.overrideWithValue(prefs),
        ringChannelProvider.overrideWithValue(RingChannel()),
        jobsRepoProvider.overrideWithValue(cfg.noSignal ? _NoSignal(fixture) : fixture),
        meProvider.overrideWith(
          (_) async => RiderMe(
            id: 'preview',
            name: 'Ravi Kumar',
            availability: RiderAvailabilityDto(
              isOnline: !cfg.offline,
              onlineSince: cfg.offline ? null : now,
              lastFixAt: cfg.offline ? null : now,
            ),
            phase: cfg.offline ? 'offline' : 'online',
          ),
        ),
      ],
    );
    _fixTimer?.cancel();
    final fix = cfg.fix;
    if (fix != null) {
      // Kept fresh, as the location service would.
      void set() => container.read(latestFixProvider.notifier).set((lat: fix.lat, lng: fix.lng, at: DateTime.now()));
      set();
      _fixTimer = Timer.periodic(const Duration(seconds: 30), (_) => set());
    }
    final old = _container;
    setState(() {
      _container = container;
      _key = UniqueKey();
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => old?.dispose());
  }

  Future<void> _pick() async {
    final ctx = _navigator.currentContext;
    if (ctx == null) return;
    final next = await showModalBottomSheet<_Config>(
      context: ctx,
      isScrollControlled: true,
      builder: (context) => _Picker(config: _config),
    );
    if (next == null) return;
    _config = next;
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final container = _container;
    return MaterialApp(
      navigatorKey: _navigator,
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: _config.dark ? ThemeMode.dark : ThemeMode.light,
      builder: (context, child) => Stack(
        children: [
          ?child,
          // Just under the status bar, which takes its own touches.
          Positioned(
            left: 0,
            top: MediaQuery.paddingOf(context).top,
            child: GestureDetector(
              key: const Key('preview-picker'),
              behavior: HitTestBehavior.opaque,
              onTap: _pick,
              child: Semantics(
                label: 'Preview settings',
                button: true,
                child: Container(
                  width: 14,
                  height: 14,
                  margin: const EdgeInsets.all(2),
                  decoration: BoxDecoration(color: Colors.black.withValues(alpha: .14), shape: BoxShape.circle),
                ),
              ),
            ),
          ),
        ],
      ),
      home: container == null
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : UncontrolledProviderScope(key: _key, container: container, child: const JobsScreen()),
    );
  }
}

class _Picker extends StatefulWidget {
  const _Picker({required this.config});

  final _Config config;

  @override
  State<_Picker> createState() => _PickerState();
}

class _PickerState extends State<_Picker> {
  late _Config _c = widget.config;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Preview', style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final s in FixtureData.scenarios)
                  ChoiceChip(
                    key: Key('pv-scenario-$s'),
                    label: Text(s),
                    selected: _c.scenario == s,
                    onSelected: (_) => setState(() => _c = _c.copyWith(scenario: s)),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final e in _fixes.entries)
                  ChoiceChip(
                    key: Key('pv-fix-${e.key}'),
                    label: Text('fix: ${e.key}'),
                    selected: _c.fix == e.value,
                    onSelected: (_) => setState(() => _c = _c.copyWith(fix: e.value)),
                  ),
              ],
            ),
            SwitchListTile(
              key: const Key('pv-nosignal'),
              title: const Text('No signal'),
              value: _c.noSignal,
              onChanged: (v) => setState(() => _c = _c.copyWith(noSignal: v)),
            ),
            SwitchListTile(
              key: const Key('pv-dark'),
              title: const Text('Dark'),
              value: _c.dark,
              onChanged: (v) => setState(() => _c = _c.copyWith(dark: v)),
            ),
            SwitchListTile(
              key: const Key('pv-offline'),
              title: const Text('Rider offline'),
              value: _c.offline,
              onChanged: (v) => setState(() => _c = _c.copyWith(offline: v)),
            ),
            FilledButton(
              key: const Key('pv-apply'),
              onPressed: () => Navigator.of(context).pop(_c),
              child: const Text('Apply'),
            ),
          ],
        ),
      ),
    );
  }
}
