import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/alerts.dart';
import '../../models/manager_me.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/zone_picker.dart';

/// Raise a technical or operational incident (§14.13): what, details, how
/// bad, and which zone. Returns the draft, or null when dismissed.
Future<IncidentDraft?> showRaiseIncidentSheet(BuildContext context) => showModalBottomSheet<IncidentDraft>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const _IncidentSheet(),
    );

class _IncidentSheet extends ConsumerStatefulWidget {
  const _IncidentSheet();

  @override
  ConsumerState<_IncidentSheet> createState() => _IncidentSheetState();
}

class _IncidentSheetState extends ConsumerState<_IncidentSheet> {
  final _title = TextEditingController();
  final _body = TextEditingController();
  AlertSeverity _severity = AlertSeverity.warning;
  String? _zoneId;

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  bool get _valid =>
      _title.text.trim().length >= 3 && _body.text.trim().length >= 3 && _zoneId != null;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final zones = ref.watch(managerMeProvider).value?.zones.zones ?? const <Zone>[];
    _zoneId ??= ref.read(activeZoneProvider)?.id ?? (zones.isEmpty ? null : zones.first.id);
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + MediaQuery.viewInsetsOf(context).bottom),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Raise an incident', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)),
            const SizedBox(height: 4),
            Text('Every manager in the zone is alerted. Use it for outages and operational problems.',
                style: TextStyle(color: c.muted, fontSize: 13)),
            const SizedBox(height: 12),
            TextField(
              key: const Key('incident-title'),
              controller: _title,
              maxLength: 120,
              textCapitalization: TextCapitalization.sentences,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'What is happening', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 8),
            TextField(
              key: const Key('incident-body'),
              controller: _body,
              minLines: 3,
              maxLines: 6,
              maxLength: 1000,
              textCapitalization: TextCapitalization.sentences,
              onChanged: (_) => setState(() {}),
              decoration: const InputDecoration(labelText: 'Details', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 8),
            Wrap(spacing: 8, children: [
              for (final s in const [AlertSeverity.warning, AlertSeverity.critical])
                ChoiceChip(
                  key: Key('incident-severity-${s.wire}'),
                  label: Text(s.label),
                  selected: _severity == s,
                  onSelected: (_) => setState(() => _severity = s),
                ),
            ]),
            if (zones.length > 1) ...[
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                key: const Key('incident-zone'),
                initialValue: _zoneId,
                decoration: const InputDecoration(labelText: 'Zone', border: OutlineInputBorder(), isDense: true),
                items: [for (final z in zones) DropdownMenuItem(value: z.id, child: Text('${z.name} · ${z.cityName}'))],
                onChanged: (v) => setState(() => _zoneId = v),
              ),
            ],
            const SizedBox(height: 16),
            FilledButton(
              key: const Key('incident-submit'),
              onPressed: _valid
                  ? () => Navigator.pop(
                        context,
                        IncidentDraft(
                          title: _title.text.trim(),
                          body: _body.text.trim(),
                          severity: _severity,
                          zoneId: _zoneId!,
                        ),
                      )
                  : null,
              child: const Text('Raise incident'),
            ),
          ],
        ),
      ),
    );
  }
}
