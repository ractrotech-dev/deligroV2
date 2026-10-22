import 'dart:convert';

import 'package:intl/intl.dart';

import 'json_util.dart';

/// The audit log (§16) as `/api/manager/audit*` sends it. Read only: nothing
/// in the app can change an entry.
class AuditActor {
  const AuditActor({required this.id, required this.name, required this.role});
  final String id;
  final String name;
  final String role;

  String get roleLabel => switch (role) {
        'admin' => 'Admin',
        'manager' => 'Manager',
        'system' => 'System',
        _ => role,
      };
}

class AuditEntry {
  const AuditEntry({
    required this.id,
    required this.action,
    required this.actor,
    this.at,
    this.entityType = '',
    this.entityId = '',
    this.zoneId,
    this.reason,
    this.before,
    this.after,
    this.clientActionId,
  });

  factory AuditEntry.fromJson(Map<String, dynamic> j) {
    final a = jMap(j['actor']) ?? const {};
    return AuditEntry(
      id: jInt(j['id']),
      at: jDate(j['at']),
      action: jStrOr(j['action']),
      actor: AuditActor(id: jStrOr(a['id']), name: jStrOr(a['name'], 'System'), role: jStrOr(a['role'], 'system')),
      entityType: jStrOr(j['entityType']),
      entityId: jStrOr(j['entityId']),
      zoneId: jStr(j['zoneId']),
      reason: jStr(j['reason']),
      before: jMap(j['before']),
      after: jMap(j['after']),
      clientActionId: jStr(j['clientActionId']),
    );
  }

  final int id;
  final DateTime? at;
  final String action;
  final AuditActor actor;
  final String entityType;
  final String entityId;
  final String? zoneId;
  final String? reason;
  final Map<String, dynamic>? before;
  final Map<String, dynamic>? after;
  final String? clientActionId;
}

class AuditPage {
  const AuditPage({required this.items, this.nextCursor});

  factory AuditPage.fromJson(Map<String, dynamic> j) => AuditPage(
        items: [for (final e in jMaps(j['items'])) AuditEntry.fromJson(e)],
        nextCursor: jStr(j['nextCursor']),
      );

  final List<AuditEntry> items;
  final String? nextCursor;
}

/// One changed field: its dotted path and both values as text ("—" for none).
class AuditDiffRow {
  const AuditDiffRow({required this.path, required this.before, required this.after});

  factory AuditDiffRow.fromJson(Map<String, dynamic> j) =>
      AuditDiffRow(path: jStrOr(j['path']), before: auditValue(j['before']), after: auditValue(j['after']));

  final String path;
  final String before;
  final String after;
}

/// A stored value as one line of text.
String auditValue(Object? v) => switch (v) {
      null => '—',
      String s => s.isEmpty ? '—' : s,
      num() || bool() => '$v',
      _ => jsonEncode(v),
    };

class AuditEntryDetail {
  const AuditEntryDetail({required this.entry, this.diff = const []});

  factory AuditEntryDetail.fromJson(Map<String, dynamic> j) => AuditEntryDetail(
        entry: AuditEntry.fromJson(jMap(j['entry']) ?? const {}),
        diff: [for (final d in jMaps(j['diff'])) AuditDiffRow.fromJson(d)],
      );

  final AuditEntry entry;
  final List<AuditDiffRow> diff;
}

/// One kind of recorded action, from the server's catalog.
class AuditActionDef {
  const AuditActionDef({required this.code, required this.label, required this.group});

  static List<AuditActionDef> listFromJson(Map<String, dynamic> j) => [
        for (final a in jMaps(j['actions']))
          AuditActionDef(code: jStrOr(a['code']), label: jStrOr(a['label'], jStrOr(a['code'])), group: jStrOr(a['group'], 'Other')),
      ];

  final String code;
  final String label;
  final String group;
}

/// The label for [code] from [catalog], or a readable form of the code.
String auditActionLabel(String code, List<AuditActionDef> catalog) {
  for (final a in catalog) {
    if (a.code == code) return a.label;
  }
  final s = code.replaceAll(RegExp(r'[._]'), ' ').trim();
  return s.isEmpty ? 'Action' : '${s[0].toUpperCase()}${s.substring(1)}';
}

final _day = DateFormat('yyyy-MM-dd');

/// The log's filters. [action] is an exact code or a group prefix (`order.*`).
class AuditFilters {
  const AuditFilters({this.actorId, this.action, this.entityType, this.entityId, this.zoneId, this.from, this.to});

  final String? actorId;
  final String? action;
  final String? entityType;
  final String? entityId;
  final String? zoneId;
  final DateTime? from;
  final DateTime? to;

  Map<String, String> toQuery() => {
        'actor': ?actorId,
        'action': ?action,
        'entityType': ?entityType,
        'entityId': ?entityId,
        'zone': ?zoneId,
        if (from != null) 'from': _day.format(from!),
        if (to != null) 'to': _day.format(to!),
      };

  int get count => [actorId, action, entityType, entityId, if (from != null || to != null) 'd'].whereType<Object>().length;

  static const _unset = Object();

  AuditFilters copyWith({
    Object? actorId = _unset,
    Object? action = _unset,
    Object? entityType = _unset,
    Object? entityId = _unset,
    Object? zoneId = _unset,
    Object? from = _unset,
    Object? to = _unset,
  }) =>
      AuditFilters(
        actorId: identical(actorId, _unset) ? this.actorId : actorId as String?,
        action: identical(action, _unset) ? this.action : action as String?,
        entityType: identical(entityType, _unset) ? this.entityType : entityType as String?,
        entityId: identical(entityId, _unset) ? this.entityId : entityId as String?,
        zoneId: identical(zoneId, _unset) ? this.zoneId : zoneId as String?,
        from: identical(from, _unset) ? this.from : from as DateTime?,
        to: identical(to, _unset) ? this.to : to as DateTime?,
      );

  @override
  bool operator ==(Object other) => other is AuditFilters && other.toQuery().toString() == toQuery().toString();

  @override
  int get hashCode => toQuery().toString().hashCode;
}

/// The action prefix for a catalog group: "Orders" → `order.*`, using the
/// codes the group actually holds.
String? actionPrefixForGroup(String group, List<AuditActionDef> catalog) {
  final prefixes = {
    for (final a in catalog.where((a) => a.group == group)) a.code.split('.').first,
  };
  if (prefixes.length == 1) return '${prefixes.first}.*';
  return null;
}
