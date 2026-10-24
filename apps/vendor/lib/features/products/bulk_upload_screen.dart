import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/export.dart';
import '../../models/bulk.dart';
import '../../state/menu.dart';
import '../../theme/app_theme.dart';
import '../../widgets/form_bits.dart';

const _maxBytes = 2 * 1024 * 1024;
const _xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/// Bulk upload of the menu and its stock from an Excel or CSV sheet: get the
/// current menu (or a blank template) as a sheet, change it, send it back, read
/// what it would do, and only then apply it. A column the sheet leaves out is
/// not touched, and an empty cell leaves the dish as it is.
class BulkUploadScreen extends ConsumerStatefulWidget {
  const BulkUploadScreen({super.key});

  @override
  ConsumerState<BulkUploadScreen> createState() => _BulkUploadScreenState();
}

class _BulkUploadScreenState extends ConsumerState<BulkUploadScreen> {
  bool _busy = false;
  String? _fileName;
  List<int>? _bytes;
  BulkOutcome? _outcome;
  String? _error;

  Future<void> _download({required bool xlsx, required bool template}) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final bytes = await ref.read(bulkRepoProvider).download(xlsx: xlsx, template: template);
      final base = template ? 'menu-template' : 'menu';
      await shareBytes(bytes, '$base.${xlsx ? 'xlsx' : 'csv'}', xlsx ? _xlsxMime : 'text/csv');
    } on ApiException catch (e) {
      _error = e.friendly();
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
    final bytes = _bytes;
    if (bytes == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final outcome = await ref.read(bulkRepoProvider).send(bytes, _fileName ?? 'sheet.csv', apply: apply);
      if (!mounted) return;
      setState(() => _outcome = outcome);
      if (apply) await ref.read(menuProvider.notifier).refresh();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.friendly());
    } catch (_) {
      if (mounted) setState(() => _error = 'Something went wrong. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final outcome = _outcome;
    return Scaffold(
      appBar: AppBar(title: const Text('Bulk upload')),
      body: ListView(
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 0),
            child: Text(
              'Change prices, stock and availability for many dishes at once, or add new dishes, from an Excel or CSV sheet. '
              'You see every change before it is saved.',
              style: TextStyle(color: c.muted, fontSize: 14, height: 1.4),
            ),
          ),
          const SectionHeading('1. Get a sheet'),
          Panel(
            padding: EdgeInsets.zero,
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.table_chart_outlined),
                  title: const Text('Your current menu (Excel)'),
                  subtitle: const Text('Every dish with its id, price and stock'),
                  enabled: !_busy,
                  onTap: () => _download(xlsx: true, template: false),
                ),
                Divider(height: 1, color: c.line),
                ListTile(
                  leading: const Icon(Icons.description_outlined),
                  title: const Text('Your current menu (CSV)'),
                  enabled: !_busy,
                  onTap: () => _download(xlsx: false, template: false),
                ),
                Divider(height: 1, color: c.line),
                ListTile(
                  leading: const Icon(Icons.note_add_outlined),
                  title: const Text('Blank template'),
                  subtitle: const Text('Two example rows to copy'),
                  enabled: !_busy,
                  onTap: () => _download(xlsx: true, template: true),
                ),
              ],
            ),
          ),
          const SectionHeading('2. Upload it back'),
          Panel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                FilledButton.icon(
                  onPressed: _busy ? null : _pick,
                  icon: const Icon(Icons.upload_file_rounded),
                  label: const Text('Choose a file'),
                ),
                if (_fileName != null) ...[
                  const SizedBox(height: 10),
                  Text(_fileName!, style: TextStyle(color: c.muted, fontSize: 13)),
                ],
                if (_busy) ...[
                  const SizedBox(height: 12),
                  const LinearProgressIndicator(),
                ],
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, style: TextStyle(color: c.deal, fontWeight: FontWeight.w600)),
                ],
              ],
            ),
          ),
          if (outcome != null) ..._result(context, outcome),
        ],
      ),
    );
  }

  List<Widget> _result(BuildContext context, BulkOutcome o) {
    final c = context.colors;
    final applied = o.applied;
    return [
      SectionHeading(applied == null ? '3. What will change' : 'Done'),
      Panel(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: 8,
              runSpacing: 6,
              children: [
                _Chip('${o.create} new', c.green, c.greenSoft),
                _Chip('${o.update} to change', c.accentInk, c.accentSoft),
                _Chip('${o.unchanged} same', c.muted, c.surface2),
                _Chip('${o.error} with problems', o.error > 0 ? c.deal : c.muted, o.error > 0 ? c.dealSoft : c.surface2),
              ],
            ),
            if (applied != null) ...[
              const SizedBox(height: 12),
              Text(
                '${applied.created} added, ${applied.updated} changed${applied.failed > 0 ? ', ${applied.failed} not saved' : ''}.',
                style: TextStyle(color: c.green, fontWeight: FontWeight.w800, fontSize: 15),
              ),
              for (final e in applied.errors) Text(e, style: TextStyle(color: c.deal, fontSize: 13)),
            ],
            if (o.ignoredColumns.isNotEmpty) _note(c, 'Not used here: ${o.ignoredColumns.join(', ')}.'),
            if (o.unknownColumns.isNotEmpty) _note(c, 'Ignored columns: ${o.unknownColumns.join(', ')}.'),
            for (final issue in o.issues.take(20))
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(issue, style: TextStyle(color: c.deal, fontSize: 13)),
              ),
            if (applied == null) ...[
              const SizedBox(height: 14),
              FilledButton(
                onPressed: _busy || o.toApply == 0 ? null : () => _send(apply: true),
                child: Text(o.toApply == 0 ? 'Nothing to apply' : 'Apply ${o.toApply} change${o.toApply == 1 ? '' : 's'}'),
              ),
              if (o.error > 0 && o.toApply > 0) _note(c, 'Rows with problems are skipped.'),
            ],
          ],
        ),
      ),
      const SizedBox(height: 10),
      for (final i in o.items.where((i) => i.action != 'unchanged'))
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: _ItemTile(item: i),
        ),
      if (o.moreItems > 0)
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
          child: Text('+${o.moreItems} more rows', style: TextStyle(color: c.muted, fontSize: 13)),
        ),
    ];
  }

  Widget _note(AppColors c, String text) =>
      Padding(padding: const EdgeInsets.only(top: 6), child: Text(text, style: TextStyle(color: c.muted, fontSize: 13)));
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

class _ItemTile extends StatelessWidget {
  const _ItemTile({required this.item});
  final BulkItem item;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final (label, ink) = switch (item.action) {
      'create' => ('New', c.green),
      'update' => ('Change', c.ink),
      _ => ('Problem', c.deal),
    };
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: c.surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: c.line)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 58, child: Text(label, style: TextStyle(color: ink, fontWeight: FontWeight.w800, fontSize: 13))),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${item.name}  ·  row ${item.line}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(item.message ?? item.changes.join('  ·  '), style: TextStyle(color: c.muted, fontSize: 13)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
