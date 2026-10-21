import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/format.dart';
import '../../core/i18n.dart';
import '../../models/stats.dart';
import '../../state/session.dart';
import '../../state/stats.dart';
import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../../widgets/zone_picker.dart';
import '../home/dashboard_grid.dart' show wideBreakpoint;
import 'peak_hours_grid.dart';
import 'stats_charts.dart';
import 'stats_export.dart';

/// Business statistics and growth (§2): pick a period, read the twelve items
/// in the document's order, take the report away.
class StatsScreen extends ConsumerWidget {
  const StatsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final allowed = me != null && (me.isAdmin || me.can('manager.reports.view'));
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(tr(ref, 'Statistics', 'आँकड़े'))),
      body: me == null
          ? const Center(child: CircularProgressIndicator())
          : !allowed
              ? EmptyLine(tr(ref, "You don't have access to statistics. Ask an admin.",
                  'आपको आँकड़े देखने की अनुमति नहीं है। एडमिन से पूछें।'))
              : const _Body(),
    );
  }
}

class _Body extends ConsumerWidget {
  const _Body();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final stats = ref.watch(statsProvider);
    return RefreshIndicator(
      onRefresh: () => ref.refresh(statsProvider.future),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          const _PeriodPicker(),
          const SizedBox(height: 8),
          const Align(alignment: Alignment.centerLeft, child: ZonePickerChip()),
          const SizedBox(height: 8),
          stats.when(
            skipLoadingOnRefresh: true,
            skipLoadingOnReload: true,
            loading: () => const Padding(padding: EdgeInsets.all(40), child: Center(child: CircularProgressIndicator())),
            error: (e, _) => _StatsError(error: e),
            data: (d) => _Sections(d: d),
          ),
        ],
      ),
    );
  }
}

class _StatsError extends ConsumerWidget {
  const _StatsError({required this.error});
  final Object error;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final e = error;
    if (e is ApiException) {
      if (e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
      final words = switch (e.code) {
        'range_too_long' => tr(ref, 'Pick a range of a year or less.', 'एक साल या उससे कम की अवधि चुनें।'),
        'range_reversed' =>
          tr(ref, 'The end date must be on or after the start date.', 'अंतिम तारीख़ शुरुआती तारीख़ के बाद होनी चाहिए।'),
        'range_in_future' => tr(ref, "The range can't end after today.", 'अवधि आज के बाद ख़त्म नहीं हो सकती।'),
        'bad_date' => tr(ref, 'Pick valid dates.', 'सही तारीख़ें चुनें।'),
        _ => null,
      };
      if (words != null) return EmptyLine(words);
    }
    return ErrorRetry(error: e, onRetry: () => ref.invalidate(statsProvider));
  }
}

/// Day · Week · Month · Year · Custom (§2.2, §2.3).
class _PeriodPicker extends ConsumerWidget {
  const _PeriodPicker();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = ref.watch(statsQueryProvider);
    final labels = {
      Period.day: tr(ref, 'Day', 'दिन'),
      Period.week: tr(ref, 'Week', 'हफ़्ता'),
      Period.month: tr(ref, 'Month', 'महीना'),
      Period.year: tr(ref, 'Year', 'साल'),
      Period.custom: tr(ref, 'Custom', 'चुनी अवधि'),
    };
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final p in Period.values)
          ChoiceChip(
            key: Key('period-${p.name}'),
            label: Text(labels[p]!),
            selected: q.period == p,
            onSelected: (_) async {
              if (p != Period.custom) {
                ref.read(statsQueryProvider.notifier).setPeriod(p);
                return;
              }
              // India's today, not the phone's: the server refuses a range that
              // ends after the IST day (range_in_future).
              final today = istToday();
              final picked = await showDateRangePicker(
                context: context,
                firstDate: DateTime(today.year - 2, 1, 1),
                lastDate: today,
                initialDateRange: q.custom,
                helpText: tr(ref, 'Pick a range (a year at most)', 'अवधि चुनें (अधिकतम एक साल)'),
              );
              if (picked != null) ref.read(statsQueryProvider.notifier).setCustom(picked);
            },
          ),
      ],
    );
  }
}

String _range(String from, String to) => periodWords(from, to);

class _Sections extends ConsumerWidget {
  const _Sections({required this.d});
  final StatsData d;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final period = Text(
      tr(ref, '${_range(d.from, d.to)} · compared with ${_range(d.previousFrom, d.previousTo)}',
          '${_range(d.from, d.to)} · तुलना ${_range(d.previousFrom, d.previousTo)} से'),
      style: TextStyle(fontSize: 12.5, color: c.muted),
    );
    final growth = _Section(
      title: tr(ref, 'Growth', 'बढ़त'),
      child: Column(children: [
        _GrowthRow(id: 'sales', label: tr(ref, 'Sales', 'बिक्री'), value: rupees(d.sales), g: d.salesGrowth),
        _GrowthRow(id: 'orders', label: tr(ref, 'Orders', 'ऑर्डर'), value: count(d.orders), g: d.ordersGrowth),
      ]),
    );
    if (d.isEmpty) {
      // Nothing this period — but if the period before had orders, the fall to
      // nothing (−100%) is the most important figure on the screen.
      final hadOrders = d.salesGrowth.previous > 0 || d.ordersGrowth.previous > 0;
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        period,
        EmptyLine(tr(ref, 'No orders in this period.', 'इस अवधि में कोई ऑर्डर नहीं।')),
        if (hadOrders) growth,
      ]);
    }
    final whoLabels = {
      'customer': tr(ref, 'Customer', 'ग्राहक'),
      'vendor': tr(ref, 'Vendor', 'वेंडर'),
      'manager': tr(ref, 'Manager', 'मैनेजर'),
      'admin': tr(ref, 'Admin', 'एडमिन'),
      'system': tr(ref, 'System', 'सिस्टम'),
      'unknown': tr(ref, 'Not recorded', 'दर्ज नहीं'),
    };
    final pct = NumberFormat.percentPattern();

    final daily = _Section(
      title: tr(ref, 'Day-by-day sales', 'रोज़ की बिक्री'),
      trailing: rupees(d.sales),
      child: SalesLineChart(points: d.daily),
    );
    final orders = _Section(
      title: tr(ref, 'Orders', 'ऑर्डर'),
      trailing: count(d.orders),
      child: OrdersBarChart(points: d.buckets, granularity: d.bucketGranularity),
    );
    final completed = _Section(
      title: tr(ref, 'Completed vs cancelled', 'पूरे बनाम रद्द'),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: _Figure(
              label: tr(ref, 'Completed', 'पूरे'),
              value: count(d.completed.count),
              note: '${rupees(d.completed.value)} · ${pct.format(d.completionRate)}',
            ),
          ),
          Expanded(
            child: _Figure(
              label: tr(ref, 'Cancelled', 'रद्द'),
              value: count(d.cancelled.count),
              note: '${rupees(d.cancelled.value)} · ${pct.format(d.cancellationRate)}',
            ),
          ),
        ]),
        if (d.cancelled.count > 0) ...[
          const SizedBox(height: 10),
          Text(tr(ref, 'Cancelled by', 'किसने रद्द किया'), style: TextStyle(fontSize: 12.5, color: c.muted)),
          for (final e in d.cancelledBy.entries.where((e) => e.value > 0))
            _Line(label: whoLabels[e.key] ?? e.key, value: count(e.value)),
          if (d.topReasons.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(tr(ref, 'Reasons', 'कारण'), style: TextStyle(fontSize: 12.5, color: c.muted)),
            for (final r in d.topReasons) _Line(label: r.reason, value: count(r.count)),
          ],
        ],
      ]),
    );
    final aov = _Section(
      title: tr(ref, 'Average order value', 'औसत ऑर्डर मूल्य'),
      child: _GrowthRow(id: 'aov', label: tr(ref, 'Per order', 'प्रति ऑर्डर'), value: rupees(d.aov), g: d.aovGrowth),
    );
    final peak = _Section(
      title: tr(ref, 'Peak ordering hours', 'सबसे व्यस्त घंटे'),
      trailing: d.topHours.isEmpty
          ? null
          : tr(ref, 'Busiest: ${hourLabel(d.topHours.first.hour)}', 'सबसे व्यस्त: ${hourLabel(d.topHours.first.hour)}'),
      child: PeakHoursGrid(grid: d.peakGrid),
    );
    final vendors = _Section(
      title: tr(ref, 'Best-performing vendors', 'सबसे अच्छे वेंडर'),
      child: Column(children: [
        for (var i = 0; i < d.bestVendors.length; i++)
          _Ranked(
            rank: i + 1,
            name: d.bestVendors[i].name,
            value: rupees(d.bestVendors[i].sales),
            note: [
              tr(ref, '${count(d.bestVendors[i].orders)} orders', '${count(d.bestVendors[i].orders)} ऑर्डर'),
            ],
            rating: d.bestVendors[i].rating,
          ),
      ]),
    );
    final categories = _Section(
      title: tr(ref, 'Best-performing categories', 'सबसे अच्छी श्रेणियाँ'),
      child: d.bestCategories.isEmpty
          ? EmptyLine(tr(ref, 'No categorised dishes in this period.', 'इस अवधि में श्रेणी वाले व्यंजन नहीं।'))
          : Column(children: [
              for (var i = 0; i < d.bestCategories.length; i++)
                _Ranked(
                  rank: i + 1,
                  name: d.bestCategories[i].category,
                  value: rupees(d.bestCategories[i].sales),
                  note: [tr(ref, '${count(d.bestCategories[i].qty)} sold', '${count(d.bestCategories[i].qty)} बिके')],
                ),
            ]),
    );
    // Each city's subtotal, then its zones; zones whose city is unknown last.
    final cityNames = {for (final c in d.byCity) c.cityName};
    final places = _Section(
      title: tr(ref, 'By city and zone', 'शहर और ज़ोन के अनुसार'),
      child: Column(children: [
        for (final city in d.byCity) ...[
          _Ranked(
            key: Key('city-${city.cityName}'),
            name: city.cityName,
            value: rupees(city.sales),
            note: [tr(ref, '${count(city.orders)} orders · city total', '${count(city.orders)} ऑर्डर · शहर का कुल')],
            emphasis: true,
          ),
          for (final z in d.byZone.where((z) => z.cityName == city.cityName))
            _Ranked(
              name: '${city.cityName} · ${z.zoneName}',
              value: rupees(z.sales),
              note: [tr(ref, '${count(z.orders)} orders', '${count(z.orders)} ऑर्डर')],
              indent: true,
            ),
        ],
        for (final z in d.byZone.where((z) => z.cityName == null || !cityNames.contains(z.cityName)))
          _Ranked(
            name: z.cityName == null ? z.zoneName : '${z.cityName} · ${z.zoneName}',
            value: rupees(z.sales),
            note: [tr(ref, '${count(z.orders)} orders', '${count(z.orders)} ऑर्डर')],
          ),
      ]),
    );

    return LayoutBuilder(builder: (context, box) {
      final download = Padding(padding: const EdgeInsets.only(top: 20), child: _DownloadButton(d: d));
      if (box.maxWidth < wideBreakpoint) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [period, daily, growth, orders, completed, aov, peak, vendors, categories, places, download],
        );
      }
      // A tablet or a landscape phone: the charts on the left, the figures and
      // rankings beside them — not one phone column stretched across.
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        period,
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [daily, orders, peak, places])),
          const SizedBox(width: 28),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [growth, completed, aov, vendors, categories]),
          ),
        ]),
        download,
      ]);
    });
  }
}

/// §2.12 — the performance report, built on the phone from what is on screen.
class _DownloadButton extends ConsumerWidget {
  const _DownloadButton({required this.d});
  final StatsData d;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FilledButton.icon(
      key: const Key('stats-download'),
      icon: const Icon(Icons.download_rounded),
      label: Text(tr(ref, 'Download report', 'रिपोर्ट डाउनलोड करें')),
      onPressed: () => showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (sheet) => SafeArea(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (final (f, label, icon) in const [
              (ReportFormat.csv, 'CSV', Icons.description_outlined),
              (ReportFormat.excel, 'Excel', Icons.table_chart_outlined),
              (ReportFormat.pdf, 'PDF', Icons.picture_as_pdf_outlined),
            ])
              ListTile(
                leading: Icon(icon),
                title: Text(label),
                onTap: () async {
                  Navigator.of(sheet).pop();
                  final me = ref.read(managerMeProvider).value;
                  final zone = ref.read(activeZoneProvider);
                  final meta = reportMetaFor(
                    d,
                    generatedBy: me?.profile.displayName ?? '',
                    zone: zone == null ? (me?.zones.all == true ? 'All zones' : 'All my zones') : '${zone.cityName} · ${zone.name}',
                  );
                  try {
                    await shareStatsReport(d, meta, f);
                  } catch (_) {
                    if (context.mounted) {
                      showSnack(context, tr(ref, "Couldn't make the file. Try again.", 'फ़ाइल नहीं बन सकी। फिर कोशिश करें।'));
                    }
                  }
                },
              ),
          ]),
        ),
      ),
    );
  }
}

/// A titled group, separated by a hairline rather than boxed.
class _Section extends StatelessWidget {
  const _Section({required this.title, required this.child, this.trailing});
  final String title;
  final String? trailing;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.only(top: 18, bottom: 6),
      margin: const EdgeInsets.only(top: 14),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: c.line))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(children: [
            Expanded(
              child: Text(title, style: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700, color: c.ink)),
            ),
            if (trailing != null) Text(trailing!, style: dataStyle(context, size: 13.5)),
          ]),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }
}

class _GrowthRow extends ConsumerWidget {
  const _GrowthRow({required this.id, required this.label, required this.value, required this.g});
  final String id;
  final String label;
  final String value;
  final Growth g;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final pct = g.pct;
    final dir = pct == null ? 'new' : (pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat'));
    final color = switch (dir) {
      'up' || 'new' => c.green,
      'down' => c.deal,
      _ => c.muted,
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(children: [
        Expanded(child: Text(label, style: TextStyle(fontSize: 14, color: c.ink))),
        Text(value, style: dataStyle(context, size: 15, weight: FontWeight.w700)),
        const SizedBox(width: 10),
        Container(
          key: Key('growth-$id-$dir'),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(color: color.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(999)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            if (dir == 'up') Icon(Icons.arrow_upward_rounded, size: 13, color: color),
            if (dir == 'down') Icon(Icons.arrow_downward_rounded, size: 13, color: color),
            Text(
              pct == null ? tr(ref, 'New', 'नया') : '${pct.abs().toStringAsFixed(1)}%',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: color),
            ),
          ]),
        ),
      ]),
    );
  }
}

class _Figure extends StatelessWidget {
  const _Figure({required this.label, required this.value, required this.note});
  final String label;
  final String value;
  final String note;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label, style: TextStyle(fontSize: 12.5, color: c.muted)),
      const SizedBox(height: 2),
      Text(value, style: dataStyle(context, size: 20, weight: FontWeight.w700)),
      Text(note, style: TextStyle(fontSize: 12, color: c.muted)),
    ]);
  }
}

class _Line extends StatelessWidget {
  const _Line({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 3),
        child: Row(children: [
          Expanded(child: Text(label, style: TextStyle(fontSize: 13.5, color: context.colors.ink))),
          Text(value, style: dataStyle(context, size: 13)),
        ]),
      );
}

class _Ranked extends StatelessWidget {
  const _Ranked({
    super.key,
    this.rank,
    required this.name,
    required this.value,
    this.note = const [],
    this.rating,
    this.emphasis = false,
    this.indent = false,
  });
  final int? rank;

  /// A subtotal row (a city above its zones).
  final bool emphasis;

  /// A row under a subtotal.
  final bool indent;
  final String name;
  final String value;
  final List<String> note;
  /// Shown as a star icon and the rating — a ★ character is missing from
  /// some fonts and draws as an empty box.
  final double? rating;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: EdgeInsets.only(top: 7, bottom: 7, left: indent ? 14 : 0),
      child: Row(children: [
        if (rank != null)
          SizedBox(width: 26, child: Text('$rank', style: dataStyle(context, size: 13, weight: FontWeight.w700))),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 14, fontWeight: emphasis ? FontWeight.w800 : FontWeight.w600, color: c.ink)),
            Row(children: [
              if (note.isNotEmpty) Text(note.join(' · '), style: TextStyle(fontSize: 12, color: c.muted)),
              if (rating != null) ...[
                const SizedBox(width: 8),
                Icon(Icons.star_rounded, size: 13, color: c.popInk),
                const SizedBox(width: 2),
                Text(rating!.toStringAsFixed(1),
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.popInk)),
              ],
            ]),
          ]),
        ),
        Text(value, style: dataStyle(context, size: 14, weight: FontWeight.w700)),
      ]),
    );
  }
}
