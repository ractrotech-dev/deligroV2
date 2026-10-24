import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/api.dart';
import '../../models/bulk.dart';
import '../../models/orders.dart' show VendorRef;
import '../../state/products.dart';
import '../../state/session.dart';
import '../../state/vendors.dart';
import '../../theme/app_theme.dart';

const _maxBytes = 2 * 1024 * 1024;
const _xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/// Bulk stock update for one shop from an Excel or CSV sheet: pick the shop,
/// get its dishes with their current counts as a sheet, fill in the new counts,
/// send it back, read what it would do, then apply. A manager's sheet changes
/// stock counts only (prices, availability and new dishes are the shop's), and
/// a dish whose count moved since the sheet was made is left alone.
class BulkStockScreen extends ConsumerStatefulWidget {
  const BulkStockScreen({super.key});

  @override
  ConsumerState<BulkStockScreen> createState() => _BulkStockScreenState();
}

class _BulkStockScreenState extends ConsumerState<BulkStockScreen> {
  VendorRef? _vendor;
  bool _busy = false;
  String? _fileName;
  List<int>? _bytes;
  BulkOutcome? _outcome;
  String? _error;

  Future<void> _download(bool xlsx) async {
    final vendor = _vendor;
    if (vendor == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final bytes = await ref.read(bulkStockRepoProvider).download(vendorId: vendor.id, xlsx: xlsx);
      final dir = await getTemporaryDirectory();
      final file = await File('${dir.path}/stock.${xlsx ? 'xlsx' : 'csv'}').writeAsBytes(bytes);
      await SharePlus.instance.share(
        ShareParams(files: [XFile(file.path, mimeType: xlsx ? _xlsxMime : 'text/csv')], subject: '${vendor.name} stock'),
      );
    } on ApiException catch (e) {
      _error = e.friendly;
    } catch (_) {
      _error = 'Could not download the sheet. Try again.';
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pick() async {
    final file = await FilePicker.pickFile(type: FileType.custom, allowedExtensions: const ['xlsx', 'xls', 'csv']);
    if (file == null) return;
    final bytes = await file.readAsBytes();
    if (bytes.length > _maxBytes) {
      setState(() => _error = 'That file is larger than 2 MB. Split it into smaller sheets.');
      return;
    }
    setState(() {
      _fileName = file.name;
      _bytes = bytes;
      _outcome = null;
      _error = null;
    });
    await _send(apply: false);
  }

  Future<void> _send({required bool apply}) async {
    final vendor = _vendor;
    final bytes = _bytes;
    if (vendor == null || bytes == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final outcome = await ref.read(bulkStockRepoProvider).send(vendor.id, bytes, _fileName ?? 'sheet.csv', apply: apply);
      if (mounted) setState(() => _outcome = outcome);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.friendly);
    } catch (_) {
      if (mounted) setState(() => _error = 'Something went wrong. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final vendors = ref.watch(vendorDirectoryProvider);
    final outcome = _outcome;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: const Text('Bulk stock update'), backgroundColor: c.bg),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
        children: [
          Text(
            'Update the stock counts of many dishes at once from an Excel or CSV sheet. '
            'You see every change before it is saved.',
            style: TextStyle(color: c.muted, fontSize: 14, height: 1.4),
          ),
          const SizedBox(height: 16),
          _Label('1. Choose the shop', c),
          vendors.when(
            data: (list) => DropdownButtonFormField<String>(
              key: const Key('bulk-vendor'),
              initialValue: _vendor?.id,
              isExpanded: true,
              decoration: const InputDecoration(border: OutlineInputBorder(), hintText: 'Select a shop'),
              items: [for (final v in list) DropdownMenuItem(value: v.id, child: Text(v.name, overflow: TextOverflow.ellipsis))],
              onChanged: _busy
                  ? null
                  : (id) => setState(() {
                      _vendor = list.firstWhere((v) => v.id == id);
                      _bytes = null;
                      _fileName = null;
                      _outcome = null;
                      _error = null;
                    }),
            ),
            loading: () => const LinearProgressIndicator(),
            error: (_, _) => Text('Could not load the shops. Pull back and try again.', style: TextStyle(color: c.deal)),
          ),
          const SizedBox(height: 18),
          _Label('2. Get its stock sheet', c),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: _busy || _vendor == null ? null : () => _download(true),
                icon: const Icon(Icons.table_chart_outlined),
                label: const Text('Excel'),
              ),
              OutlinedButton.icon(
                onPressed: _busy || _vendor == null ? null : () => _download(false),
                icon: const Icon(Icons.description_outlined),
                label: const Text('CSV'),
              ),
            ],
          ),
          const SizedBox(height: 18),
          _Label('3. Upload it back', c),
          FilledButton.icon(
            onPressed: _busy || _vendor == null ? null : _pick,
            icon: const Icon(Icons.upload_file_rounded),
            label: const Text('Choose a file'),
          ),
          if (_fileName != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_fileName!, style: TextStyle(color: c.muted, fontSize: 13))),
          if (_busy) const Padding(padding: EdgeInsets.only(top: 12), child: LinearProgressIndicator()),
          if (_error != null)
            Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: TextStyle(color: c.deal, fontWeight: FontWeight.w600))),
          if (outcome != null) ..._result(context, outcome),
        ],
      ),
    );
  }

  List<Widget> _result(BuildContext context, BulkOutcome o) {
    final c = context.colors;
    final applied = o.applied;
    final canAdjust = ref.watch(managerMeProvider).value?.can('manager.products.adjust_stock') ?? false;
    return [
      const SizedBox(height: 20),
      _Label(applied == null ? '4. What will change' : 'Done', c),
      Wrap(
        spacing: 8,
        runSpacing: 6,
        children: [
          _Chip('${o.update} to change', c.accentInk, c.accentSoft),
          _Chip('${o.unchanged} same', c.muted, c.surface2),
          _Chip('${o.error} with problems', o.error > 0 ? c.deal : c.muted, o.error > 0 ? c.dealSoft : c.surface2),
        ],
      ),
      if (applied != null) ...[
        const SizedBox(height: 12),
        Text(
          '${applied.updated} changed${applied.failed > 0 ? ', ${applied.failed} not saved' : ''}.',
          style: TextStyle(color: c.green, fontWeight: FontWeight.w800, fontSize: 15),
        ),
        for (final e in applied.errors) Text(e, style: TextStyle(color: c.deal, fontSize: 13)),
      ],
      if (o.ignoredColumns.isNotEmpty)
        Padding(padding: const EdgeInsets.only(top: 8), child: Text('Not used here (stock only): ${o.ignoredColumns.join(', ')}.', style: TextStyle(color: c.muted, fontSize: 13))),
      for (final issue in o.issues.take(20)) Padding(padding: const EdgeInsets.only(top: 6), child: Text(issue, style: TextStyle(color: c.deal, fontSize: 13))),
      if (applied == null) ...[
        const SizedBox(height: 14),
        FilledButton(
          key: const Key('bulk-apply'),
          onPressed: _busy || o.toApply == 0 || !canAdjust ? null : () => _send(apply: true),
          child: Text(o.toApply == 0 ? 'Nothing to apply' : 'Apply ${o.toApply} change${o.toApply == 1 ? '' : 's'}'),
        ),
        if (!canAdjust) Padding(padding: const EdgeInsets.only(top: 6), child: Text('You need the stock permission to apply. Ask an admin.', style: TextStyle(color: c.muted, fontSize: 13))),
      ],
      const SizedBox(height: 10),
      for (final i in o.items.where((i) => i.action != 'unchanged'))
        Container(
          margin: const EdgeInsets.only(bottom: 6),
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: c.line)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('${i.name}  ·  row ${i.line}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 2),
              Text(i.message ?? i.changes.join('  ·  '), style: TextStyle(color: i.isError ? c.deal : c.muted, fontSize: 13)),
            ],
          ),
        ),
      if (o.moreItems > 0) Text('+${o.moreItems} more rows', style: TextStyle(color: c.muted, fontSize: 13)),
    ];
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text, this.c);
  final String text;
  final AppColors c;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Text(text.toUpperCase(), style: TextStyle(color: c.muted, fontSize: 12.5, fontWeight: FontWeight.w700, letterSpacing: .4)),
  );
}

class _Chip extends StatelessWidget {
  const _Chip(this.label, this.ink, this.fill);
  final String label;
  final Color ink;
  final Color fill;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
    decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(10)),
    child: Text(label, style: TextStyle(color: ink, fontWeight: FontWeight.w700, fontSize: 13)),
  );
}
