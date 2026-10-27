import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../data/weather_repository.dart';
import '../../models/outcome.dart';
import '../../state/providers.dart';
import '../../state/session.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../orders/reason_dialog.dart';

/// Weather notices (0178), per zone. Deligro reads the weather by itself every
/// 15 minutes; rain or a storm adds minutes to delivery times and is shown to
/// customers and riders. A manager with Weather notices can set a level for a
/// few hours (it wins over the reading) or go back to automatic.
class WeatherScreen extends ConsumerWidget {
  const WeatherScreen({super.key});

  Future<void> _set(BuildContext context, WidgetRef ref, ZoneWeatherRow z) async {
    final level = await pickOne<String>(
      context,
      title: 'Weather in ${z.zoneName}',
      options: [for (final l in weatherLevels) (l.$1, l.$2, l.$3)],
    );
    if (level == null || !context.mounted) return;
    final hours = await pickOne<int>(
      context,
      title: 'For how long?',
      options: const [(1, '1 hour', null), (2, '2 hours', null), (3, '3 hours', null), (6, '6 hours', null), (12, '12 hours', null)],
    );
    if (hours == null || !context.mounted) return;
    await _send(context, ref, z, level: level, hours: hours);
  }

  Future<void> _send(BuildContext context, WidgetRef ref, ZoneWeatherRow z, {required String level, int? hours}) async {
    final id = const Uuid().v4();
    try {
      final out = await ref.read(weatherRepoProvider).set(zoneId: z.zoneId, level: level, hours: hours, clientActionId: id);
      if (!context.mounted) return;
      switch (out) {
        case Applied():
          ref.invalidate(zoneWeatherProvider);
          showSnack(
            context,
            level == 'auto'
                ? 'Back to the automatic reading.'
                : level == 'clear'
                    ? 'No weather notice for $hours h.'
                    : '${weatherLabel(level)} set for $hours h. Customers and riders are told.',
          );
        case Refused(:final code):
          showSnack(
            context,
            switch (code) {
              'permission_denied' || 'forbidden' => "You don't have permission to set weather. Ask an admin.",
              'not_found' => "That zone isn't one of yours.",
              _ => "That didn't go through ($code).",
            },
          );
      }
    } on ApiException catch (e) {
      if (e.unauthorized) {
        await handleUnauthorized(ref, e);
        return;
      }
      if (context.mounted) showSnack(context, e.friendly);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final canSet = ref.watch(managerMeProvider).value?.can('manager.weather.manage') ?? false;
    final time = DateFormat('h:mm a');
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Weather notices'), backgroundColor: c.bg),
      body: AsyncView(
        value: ref.watch(zoneWeatherProvider),
        onRetry: () => ref.invalidate(zoneWeatherProvider),
        builder: (zones) => RefreshIndicator(
          onRefresh: () async {
            ref.invalidate(zoneWeatherProvider);
            await ref.read(zoneWeatherProvider.future);
          },
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
            children: [
              Text(
                'Deligro checks the weather in each zone every 15 minutes. Rain or a storm adds minutes to delivery '
                'times, and customers and riders see a notice. You can set it yourself for a few hours.',
                style: TextStyle(color: c.muted, height: 1.4),
              ),
              if (zones.isEmpty) const EmptyLine('No zones assigned to you.'),
              for (final z in zones)
                Container(
                  key: Key('weather-zone-${z.zoneId}'),
                  margin: const EdgeInsets.only(top: 12),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: c.surface,
                    borderRadius: BorderRadius.circular(radiusBlock),
                    border: Border.all(color: c.line),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(z.zoneName, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: c.ink)),
                      const SizedBox(height: 4),
                      Text('Now: ${weatherLabel(z.level)}', style: TextStyle(fontWeight: FontWeight.w700, color: z.level == 'clear' ? c.muted : c.deal)),
                      if (z.manualLevel != null && z.manualUntil != null)
                        Text(
                          'Set by a manager until ${time.format(z.manualUntil!.toLocal())}${z.manualNote == null ? '' : ' · ${z.manualNote}'}',
                          style: TextStyle(color: c.muted, fontSize: 13),
                        ),
                      Text(
                        z.autoCheckedAt == null
                            ? 'Automatic reading: not yet'
                            : 'Automatic reading: ${weatherLabel(z.autoLevel)} at ${time.format(z.autoCheckedAt!.toLocal())}',
                        style: TextStyle(color: c.muted, fontSize: 13),
                      ),
                      if (canSet) ...[
                        const SizedBox(height: 10),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: [
                            FilledButton.tonal(
                              key: Key('weather-set-${z.zoneId}'),
                              onPressed: () => _set(context, ref, z),
                              child: const Text('Set weather'),
                            ),
                            if (z.manualLevel != null)
                              OutlinedButton(
                                key: Key('weather-auto-${z.zoneId}'),
                                onPressed: () => _send(context, ref, z, level: 'auto'),
                                child: const Text('Back to automatic'),
                              ),
                          ],
                        ),
                      ],
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
