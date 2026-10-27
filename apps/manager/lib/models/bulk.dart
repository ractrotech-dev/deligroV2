/// What `/api/vendor/menu/bulk` answers with, for a preview and for the apply
/// that follows it (`src/lib/bulk/outcome.ts`).
class BulkItem {
  const BulkItem({required this.line, required this.action, required this.name, required this.changes, this.message});

  final int line;

  /// `create`, `update`, `unchanged` or `error`.
  final String action;
  final String name;
  final List<String> changes;
  final String? message;

  bool get isError => action == 'error';
  bool get isChange => action == 'create' || action == 'update';

  factory BulkItem.fromJson(Map<String, dynamic> j) => BulkItem(
    line: (j['line'] as num?)?.toInt() ?? 0,
    action: '${j['action']}',
    name: '${j['name'] ?? ''}',
    changes: [for (final c in (j['changes'] as List? ?? const [])) '$c'],
    message: j['message'] as String?,
  );
}

class BulkApplied {
  const BulkApplied({required this.created, required this.updated, required this.failed, required this.errors, this.held = 0});

  final int created;
  final int updated;
  final int failed;
  final List<String> errors;

  /// A menu sheet: dishes saved but waiting for approval by someone else (restricted categories).
  final int held;

  factory BulkApplied.fromJson(Map<String, dynamic> j) => BulkApplied(
    created: (j['created'] as num?)?.toInt() ?? 0,
    updated: (j['updated'] as num?)?.toInt() ?? 0,
    failed: (j['failed'] as num?)?.toInt() ?? 0,
    errors: [for (final e in (j['errors'] as List? ?? const [])) '$e'],
    held: (j['held'] as num?)?.toInt() ?? 0,
  );
}

class BulkOutcome {
  const BulkOutcome({
    required this.applyMode,
    required this.create,
    required this.update,
    required this.unchanged,
    required this.error,
    required this.items,
    required this.moreItems,
    required this.issues,
    required this.unknownColumns,
    required this.ignoredColumns,
    this.applied,
  });

  /// True for the answer to an apply, false for a preview.
  final bool applyMode;
  final int create;
  final int update;
  final int unchanged;
  final int error;
  final List<BulkItem> items;
  final int moreItems;
  final List<String> issues;
  final List<String> unknownColumns;
  final List<String> ignoredColumns;
  final BulkApplied? applied;

  /// Rows the sheet would add or change.
  int get toApply => create + update;

  factory BulkOutcome.fromJson(Map<String, dynamic> j) {
    final counts = (j['counts'] as Map?)?.cast<String, dynamic>() ?? const {};
    int n(String k) => (counts[k] as num?)?.toInt() ?? 0;
    String issue(Map i) {
      final line = (i['line'] as num?)?.toInt() ?? 0;
      return '${line > 0 ? 'Row $line: ' : ''}${i['message']}';
    }

    return BulkOutcome(
      applyMode: j['mode'] == 'apply',
      create: n('create'),
      update: n('update'),
      unchanged: n('unchanged'),
      error: n('error'),
      items: [for (final i in (j['items'] as List? ?? const [])) BulkItem.fromJson((i as Map).cast<String, dynamic>())],
      moreItems: (j['moreItems'] as num?)?.toInt() ?? 0,
      issues: [for (final i in (j['issues'] as List? ?? const [])) if (i is Map) issue(i)],
      unknownColumns: [for (final c in (j['unknownColumns'] as List? ?? const [])) '$c'],
      ignoredColumns: [for (final c in (j['ignoredColumns'] as List? ?? const [])) '$c'],
      applied: j['applied'] is Map ? BulkApplied.fromJson((j['applied'] as Map).cast<String, dynamic>()) : null,
    );
  }
}
