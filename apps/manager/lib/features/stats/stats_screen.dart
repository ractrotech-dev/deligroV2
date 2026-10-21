import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../core/api.dart';
import '../../core/format.dart';
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
  const StatsScreen({super.key, this.vendorId, this.vendorName});

  /// Set when opened from a vendor (`/stats?vendor=<id>&name=…`): every
  /// figure is that shop's alone.
  final String? vendorId;
  final String? vendorName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final me = ref.watch(managerMeProvider).value;
    final allowed = me != null &&
        (me.isAdmin || (me.can('manager.reports.view') && (vendorId == null || me.can('manager.vendors.view'))));
    final title = vendorId == null ? 'Statistics' : 'Statistics · ${vendorName ?? 'Vendor'}';
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(title)),
      body: me == null
          ? const Center(child: CircularProgressIndicator())
          : !allowed
              ? EmptyLine("You don't have access to statistics. Ask an admin.")
              : _Body(vendorId: vendorId, vendorName: vendorName),
    );
  }
}

class _Body extends ConsumerWidget {
  const _Body({this.vendorId, this.vendorName});
  final String? vendorId;
  final String? vendorName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = statsFor(vendorId);
    final stats = ref.watch(provider);
    return RefreshIndicator(
      onRefresh: () => ref.refresh(provider.future),
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
            error: (e, _) => _StatsError(error: e, vendorId: vendorId),
            data: (d) => _Sections(d: d, vendorName: vendorId == null ? null : (vendorName ?? 'Vendor')),
          ),
        ],
      ),
    );
  }
}

class _StatsError extends ConsumerWidget {
  const _StatsError({required this.error, this.vendorId});
  final Object error;
  final String? vendorId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final e = error;
    if (e is ApiException) {
      if (e.unauthorized) Future.microtask(() => handleUnauthorized(ref, e));
      final words = switch (e.code) {
        'range_too_long' => 'Pick a range of a year or less.',
        'range_reversed' =>
          'The end date must be on or after the start date.',
        'range_in_future' => "The range can't end after today.",
        'bad_date' => 'Pick valid dates.',
        _ => null,
      };
      if (words != null) return EmptyLine(words);
    }
    return ErrorRetry(error: e, onRetry: () => ref.invalidate(statsFor(vendorId)));
  }
}

/// Day · Week · Month · Year · Custom (§2.2, §2.3).
class _PeriodPicker extends ConsumerWidget {
  const _PeriodPicker();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final q = ref.watch(statsQueryProvider);
    final labels = {
      Period.day: 'Day',
      Period.week: 'Week',
      Period.month: 'Month',
      Period.year: 'Year',
      Period.custom: 'Custom',
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
                helpText: 'Pick a range (a year at most)',
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
  const _Sections({required this.d, this.vendorName});
  final StatsData d;
  final String? vendorName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final period = Text(
      '${_range(d.from, d.to)} · compared with ${_range(d.previousFrom, d.previousTo)}',
      style: TextStyle(fontSize: 12.5, color: c.muted),
    );
    final growth = _Section(
      title: 'Growth',
      child: Column(children: [
        _GrowthRow(id: 'sales', label: 'Sales', value: rupees(d.sales), g: d.salesGrowth),
        _GrowthRow(id: 'orders', label: 'Orders', value: count(d.orders), g: d.ordersGrowth),
      ]),
    );
    if (d.isEmpty) {
      // Nothing this period — but if the period before had orders, the fall to
      // nothing (−100%) is the most important figure on the screen.
      final hadOrders = d.salesGrowth.previous > 0 || d.ordersGrowth.previous > 0;
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        period,
        EmptyLine('No orders in this period.'),
        if (hadOrders) growth,
      ]);
    }
    final whoLabels = {
      'customer': 'Customer',
      'vendor': 'Vendor',
      'manager': 'Manager',
      'admin': 'Admin',
      'system': 'System',
      'unknown': 'Not recorded',
    };
    final pct = NumberFormat.percentPattern();

    final daily = _Section(
      title: 'Day-by-day sales',
      trailing: rupees(d.sales),
      child: SalesLineChart(points: d.daily),
    );
    final orders = _Section(
      title: 'Orders',
      trailing: count(d.orders),
      child: OrdersBarChart(points: d.buckets, granularity: d.bucketGranularity),
    );
    final completed = _Section(
      title: 'Completed vs cancelled',
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: _Figure(
              label: 'Completed',
              value: count(d.completed.count),
              note: '${rupees(d.completed.value)} · ${pct.format(d.completionRate)}',
            ),
          ),
          Expanded(
            child: _Figure(
              label: 'Cancelled',
              value: count(d.cancelled.count),
              note: '${rupees(d.cancelled.value)} · ${pct.format(d.cancellationRate)}',
            ),
          ),
        ]),
        if (d.cancelled.count > 0) ...[
          const SizedBox(height: 10),
          Text('Cancelled by', style: TextStyle(fontSize: 12.5, color: c.muted)),
          for (final e in d.cancelledBy.entries.where((e) => e.value > 0))
            _Line(label: whoLabels[e.key] ?? e.key, value: count(e.value)),
          if (d.topReasons.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('Reasons', style: TextStyle(fontSize: 12.5, color: c.muted)),
            for (final r in d.topReasons) _Line(label: r.reason, value: count(r.count)),
          ],
        ],
      ]),
    );
    final aov = _Section(
      title: 'Average order value',
      child: _GrowthRow(id: 'aov', label: 'Per order', value: rupees(d.aov), g: d.aovGrowth),
    );
    final peak = _Section(
      title: 'Peak ordering hours',
      trailing: d.topHours.isEmpty
          ? null
          : 'Busiest: ${hourLabel(d.topHours.first.hour)}',
      child: PeakHoursGrid(grid: d.peakGrid),
    );
    final vendors = _Section(
      title: 'Best-performing vendors',
      child: Column(children: [
        for (var i = 0; i < d.bestVendors.length; i++)
          _Ranked(
            rank: i + 1,
            name: d.bestVendors[i].name,
            value: rupees(d.bestVendors[i].sales),
            note: [
              '${count(d.bestVendors[i].orders)} orders',
            ],
            rating: d.bestVendors[i].rating,
          ),
      ]),
    );
    final categories = _Section(
      title: 'Best-performing categories',
      child: d.bestCategories.isEmpty
          ? EmptyLine('No categorised dishes in this period.')
          : Column(children: [
              for (var i = 0; i < d.bestCategories.length; i++)
                _Ranked(
                  rank: i + 1,
                  name: d.bestCategories[i].category,
                  value: rupees(d.bestCategories[i].sales),
                  note: ['${count(d.bestCategories[i].qty)} sold'],
                ),
            ]),
    );
    // Each city's subtotal, then its zones; zones whose city is unknown last.
    final cityNames = {for (final c in d.byCity) c.cityName};
    final places = _Section(
      title: 'By city and zone',
      child: Column(children: [
        for (final city in d.byCity) ...[
          _Ranked(
            key: Key('city-${city.cityName}'),
            name: city.cityName,
            value: rupees(city.sales),
            note: ['${count(city.orders)} orders · city total'],
            emphasis: true,
          ),
          for (final z in d.byZone.where((z) => z.cityName == city.cityName))
            _Ranked(
              name: '${city.cityName} · ${z.zoneName}',
              value: rupees(z.sales),
              note: ['${count(z.orders)} orders'],
              indent: true,
            ),
        ],
        for (final z in d.byZone.where((z) => z.cityName == null || !cityNames.contains(z.cityName)))
          _Ranked(
            name: z.cityName == null ? z.zoneName : '${z.cityName} · ${z.zoneName}',
            value: rupees(z.sales),
            note: ['${count(z.orders)} orders'],
          ),
      ]),
    );

    return LayoutBuilder(builder: (context, box) {
      final download = Padding(padding: const EdgeInsets.only(top: 20), child: _DownloadButton(d: d, vendorName: vendorName));
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
  const _DownloadButton({required this.d, this.vendorName});
  final StatsData d;
  final String? vendorName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FilledButton.icon(
      key: const Key('stats-download'),
      icon: const Icon(Icons.download_rounded),
      label: Text('Download report'),
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
                    vendorName: vendorName,
                  );
                  try {
                    await shareStatsReport(d, meta, f);
                  } catch (_) {
                    if (context.mounted) {
                      showSnack(context, "Couldn't make the file. Try again.");
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
              pct == null ? 'New' : '${pct.abs().toStringAsFixed(1)}%',
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
