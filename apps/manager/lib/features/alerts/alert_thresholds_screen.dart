import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../models/alerts.dart';
import '../../models/manager_me.dart';
import '../../models/outcome.dart';
import '../../state/alerts.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';

/// Alert thresholds (§14): for one zone (or, for admins, the platform
/// default), each alert kind's switch, threshold and window. Anyone can read
/// them; changing them needs Configure alerts. A zone's own value can be
/// reset to the default.
class AlertThresholdsScreen extends ConsumerStatefulWidget {
  const AlertThresholdsScreen({super.key});

  @override
  ConsumerState<AlertThresholdsScreen> createState() => _AlertThresholdsScreenState();
}

/// A window is minutes: five minutes to a week.
const _windowMin = 5, _windowMax = 7 * 24 * 60;

class _AlertThresholdsScreenState extends ConsumerState<AlertThresholdsScreen> {
  /// The zone being edited; `''` is "All zones (default)". Null until chosen.
  String? _zone;
  bool _saving = false;

  final _threshold = <String, TextEditingController>{};
  final _window = <String, TextEditingController>{};
  final _enabled = <String, bool>{};

  /// The rules the controllers were filled from, per zone, so a refresh after
  /// saving starts clean.
  List<AlertRule>? _loadedFor;

  @override
  void dispose() {
    for (final c in [..._threshold.values, ..._window.values]) {
      c.dispose();
    }
    super.dispose();
  }

  static String _num(num v) => v == v.roundToDouble() ? '${v.round()}' : '$v';

  void _fill(List<AlertRule> rules) {
    if (identical(rules, _loadedFor)) return;
    _loadedFor = rules;
    for (final r in rules) {
      (_threshold[r.kindWire] ??= TextEditingController()).text = _num(r.threshold);
      (_window[r.kindWire] ??= TextEditingController()).text = r.windowMinutes == null ? '' : '${r.windowMinutes}';
      _enabled[r.kindWire] = r.enabled;
    }
  }

  String? _thresholdError(AlertRule r) {
    if (!r.hasThreshold) return null;
    final v = num.tryParse(_threshold[r.kindWire]?.text.trim() ?? '');
    if (v == null || v < r.unit.min || v > r.unit.max) return r.unit.bounds;
    return null;
  }

  String? _windowError(AlertRule r) {
    if (r.windowMinutes == null) return null;
    final v = int.tryParse(_window[r.kindWire]?.text.trim() ?? '');
    if (v == null || v < _windowMin || v > _windowMax) return '$_windowMin–$_windowMax';
    return null;
  }

  AlertRuleChange? _change(AlertRule r, String? zoneId) {
    final enabled = _enabled[r.kindWire] ?? r.enabled;
    final t = r.hasThreshold ? (num.tryParse(_threshold[r.kindWire]!.text.trim()) ?? r.threshold) : r.threshold;
    final w = r.windowMinutes == null ? null : (int.tryParse(_window[r.kindWire]!.text.trim()) ?? r.windowMinutes);
    if (enabled == r.enabled && t == r.threshold && w == r.windowMinutes) return null;
    return AlertRuleChange(kind: r.kindWire, zoneId: zoneId, enabled: enabled, threshold: t, windowMinutes: w);
  }

  Future<void> _save(List<AlertRuleChange> changes, String? zoneId) async {
    setState(() => _saving = true);
    final refused = <String>[];
    try {
      for (final ch in changes) {
        final out = await ref.read(alertsRepoProvider).setRule(ch);
        if (out is Refused<AlertRule>) refused.add(out.code);
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(
          content: Text("Thresholds weren't saved. ${e.friendly}"),
          duration: const Duration(seconds: 8),
          action: SnackBarAction(label: 'Retry', onPressed: () => _save(changes, zoneId)),
        ));
      return;
    }
    if (!mounted) return;
    setState(() => _saving = false);
    ref.invalidate(alertRulesProvider(zoneId));
    showSnack(
      context,
      refused.isEmpty
          ? 'Thresholds saved.'
          : refused.contains('permission_denied')
              ? 'Only an admin can change the default for all zones.'
              : "Some thresholds weren't saved (${refused.toSet().join(', ')}).",
    );
  }

  Future<void> _reset(AlertRule r, String zoneId) async {
    try {
      final out = await ref.read(alertsRepoProvider).resetRule(r.kindWire, zoneId);
      if (!mounted) return;
      ref.invalidate(alertRulesProvider(zoneId));
      showSnack(context, out is Refused ? "Couldn't reset (${out.code})." : '${r.label} uses the default again.');
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.friendly);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final zones = me?.zones.zones ?? const <Zone>[];
    // Until the manager picks one: the active zone, else their first zone —
    // decided only once their zones are known, never stuck on the default.
    final zone = _zone ?? ref.watch(activeZoneProvider)?.id ?? (zones.isEmpty ? '' : zones.first.id);
    final zoneId = zone == '' ? null : zone;
    final configure = me?.can('manager.alerts.configure') ?? false;
    final editable = configure && (zoneId != null || (me?.isAdmin ?? false));
    final value = ref.watch(alertRulesProvider(zoneId));

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Alert thresholds'), backgroundColor: c.bg),
      body: AsyncView(
        value: value,
        onRetry: () => ref.invalidate(alertRulesProvider(zoneId)),
        builder: (rules) {
          _fill(rules);
          final changes = [for (final r in rules) ?_change(r, zoneId)];
          final invalid = rules.any((r) => _thresholdError(r) != null || _windowError(r) != null);
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
            children: [
              DropdownButtonFormField<String>(
                key: ValueKey('thresholds-zone-$zone'),
                initialValue: zone,
                decoration: const InputDecoration(labelText: 'Zone', border: OutlineInputBorder(), isDense: true),
                items: [
                  const DropdownMenuItem(value: '', child: Text('All zones (default)')),
                  for (final z in zones) DropdownMenuItem(value: z.id, child: Text('${z.name} · ${z.cityName}')),
                ],
                onChanged: (v) => setState(() {
                  _zone = v ?? '';
                  _loadedFor = null;
                }),
              ),
              const SizedBox(height: 10),
              if (!configure)
                Text('Ask an admin to give you Configure alerts.',
                    key: const Key('thresholds-readonly'), style: TextStyle(color: c.muted, fontSize: 13))
              else if (!editable)
                Text('Only an admin can change the default for all zones.', style: TextStyle(color: c.muted, fontSize: 13)),
              for (final r in rules) _row(c, r, zoneId, editable),
              if (editable) ...[
                const SizedBox(height: 16),
                FilledButton(
                  key: const Key('thresholds-save'),
                  onPressed: changes.isEmpty || invalid || _saving ? null : () => _save(changes, zoneId),
                  child: Text(changes.length > 1 ? 'Save ${changes.length} changes' : 'Save'),
                ),
              ],
            ],
          );
        },
      ),
    );
  }

  Widget _row(AppColors c, AlertRule r, String? zoneId, bool editable) {
    final k = r.kindWire;
    return Container(
      margin: const EdgeInsets.only(top: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(radiusBlock),
        border: Border.all(color: c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Expanded(child: Text(r.label, style: TextStyle(fontWeight: FontWeight.w700, color: c.ink))),
            Switch(
              key: Key('rule-enabled-$k'),
              value: _enabled[k] ?? r.enabled,
              onChanged: editable ? (v) => setState(() => _enabled[k] = v) : null,
            ),
          ]),
          if (r.description.isNotEmpty) Text(r.description, style: TextStyle(color: c.muted, fontSize: 12.5)),
          if (r.hasThreshold || r.windowMinutes != null) ...[
            const SizedBox(height: 10),
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (r.hasThreshold)
                Expanded(
                  child: TextField(
                    key: Key('rule-threshold-$k'),
                    controller: _threshold[k],
                    enabled: editable,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    onChanged: (_) => setState(() {}),
                    decoration: InputDecoration(
                      labelText: 'Threshold',
                      isDense: true,
                      border: const OutlineInputBorder(),
                      prefixText: r.unit == ThresholdUnit.rupees ? '₹ ' : null,
                      suffixText: r.unit == ThresholdUnit.rupees ? null : r.unit.suffix,
                      errorText: _thresholdError(r),
                    ),
                  ),
                ),
              if (r.hasThreshold && r.windowMinutes != null) const SizedBox(width: 10),
              if (r.windowMinutes != null)
                Expanded(
                  child: TextField(
                    key: Key('rule-window-$k'),
                    controller: _window[k],
                    enabled: editable,
                    keyboardType: TextInputType.number,
                    onChanged: (_) => setState(() {}),
                    decoration: InputDecoration(
                      labelText: 'Window',
                      isDense: true,
                      border: const OutlineInputBorder(),
                      suffixText: 'min',
                      errorText: _windowError(r),
                    ),
                  ),
                ),
            ]),
          ],
          if (zoneId != null) ...[
            const SizedBox(height: 6),
            if (r.inherited)
              Text('Inherited from default', key: Key('rule-inherited-$k'), style: TextStyle(color: c.muted, fontSize: 12))
            else
              Row(children: [
                Expanded(
                  child: Text(
                    r.updatedBy == null ? 'Set for this zone' : 'Set for this zone by ${r.updatedBy!.name}',
                    style: TextStyle(color: c.muted, fontSize: 12),
                  ),
                ),
                if (editable)
                  TextButton(
                    key: Key('rule-reset-$k'),
                    onPressed: () => _reset(r, zoneId),
                    child: const Text('Reset to default'),
                  ),
              ]),
          ],
        ],
      ),
    );
  }
}
