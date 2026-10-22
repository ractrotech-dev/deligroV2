import 'json_util.dart';
import 'vendors.dart' show PersonRef, ZoneRef;

/// Reports (§13) as `/api/manager/reports*` send them (Phase 6 plan, "Report
/// registry"). The server owns every figure; the app only lays them out.
/// Label fields other than English are ignored (the manager side is
/// English only).

enum ReportColumnType {
  text,
  int,
  money,
  money2,
  percent,
  date,
  datetime,
  minutes,
  unknown;

  static ReportColumnType parse(Object? s) => jEnum(values, s, unknown);

  bool get numeric => this == int || this == money || this == money2 || this == percent || this == minutes;
}

class ReportColumn {
  const ReportColumn({required this.key, required this.label, required this.type});
  factory ReportColumn.fromJson(Map<String, dynamic> j) =>
      ReportColumn(key: jStrOr(j['key']), label: jStrOr(j['label']), type: ReportColumnType.parse(j['type']));
  final String key;
  final String label;
  final ReportColumnType type;
}

/// One entry of `GET /api/manager/reports/kinds` — only kinds the caller may run.
class ReportKindInfo {
  const ReportKindInfo({
    required this.kind,
    required this.label,
    this.blurb = '',
    this.filters = const [],
    this.statusOptions = const [],
  });
  factory ReportKindInfo.fromJson(Map<String, dynamic> j) => ReportKindInfo(
        kind: jStrOr(j['kind']),
        label: jStrOr(j['label']),
        blurb: jStrOr(j['blurb']),
        filters: jStrings(j['filters']),
        statusOptions: jStrings(j['statusOptions']),
      );
  final String kind;
  final String label;
  final String blurb;

  /// Which of `vendor`, `rider`, `status`, `zone`, `payment` this kind takes.
  final List<String> filters;
  final List<String> statusOptions;

  bool takes(String filter) => filters.contains(filter);
}

class ReportKindList {
  const ReportKindList({required this.kinds});
  factory ReportKindList.fromJson(Map<String, dynamic> j) =>
      ReportKindList(kinds: [for (final k in jMaps(j['kinds'])) ReportKindInfo.fromJson(k)]);
  final List<ReportKindInfo> kinds;
}

class ReportHighlight {
  const ReportHighlight({required this.key, required this.label, required this.type, this.value});
  factory ReportHighlight.fromJson(Map<String, dynamic> j) => ReportHighlight(
        key: jStrOr(j['key']),
        label: jStrOr(j['label']),
        value: j['value'],
        type: ReportColumnType.parse(j['type']),
      );
  final String key;
  final String label;
  final Object? value;
  final ReportColumnType type;
}

/// The filters a report was actually run with, as the server echoes them.
class ReportFilterEcho {
  const ReportFilterEcho({
    required this.from,
    required this.to,
    this.zone,
    this.vendor,
    this.rider,
    this.status,
    this.payment,
  });
  factory ReportFilterEcho.fromJson(Map<String, dynamic>? j) {
    final z = jRef(j?['zone']);
    return ReportFilterEcho(
      from: jStrOr(j?['from']),
      to: jStrOr(j?['to']),
      zone: z == null ? null : ZoneRef(id: z.id, name: z.name),
      vendor: PersonRef.fromJson(j?['vendor']),
      rider: PersonRef.fromJson(j?['rider']),
      status: jStr(j?['status']),
      payment: jStr(j?['payment']),
    );
  }
  final String from;
  final String to;
  final ZoneRef? zone;
  final PersonRef? vendor;
  final PersonRef? rider;
  final String? status;

  /// `all`, `cod` or `online`.
  final String? payment;
}

typedef ReportRow = Map<String, Object?>;

class ReportPayload {
  const ReportPayload({
    required this.kind,
    required this.title,
    required this.filters,
    this.subtitle = '',
    this.generatedAt,
    this.generatedBy = '',
    this.highlights = const [],
    this.columns = const [],
    this.rows = const [],
    this.totals,
    this.page = 1,
    this.pageSize = 50,
    this.totalRows = 0,
    this.notes = const [],
  });

  factory ReportPayload.fromJson(Map<String, dynamic> j) {
    final totals = jMap(j['totals']);
    return ReportPayload(
      kind: jStrOr(j['kind']),
      title: jStrOr(j['title']),
      subtitle: jStrOr(j['subtitle']),
      generatedAt: jDate(j['generatedAt']),
      generatedBy: jStrOr(jMap(j['generatedBy'])?['name']),
      filters: ReportFilterEcho.fromJson(jMap(j['filters'])),
      highlights: [for (final h in jMaps(j['highlights'])) ReportHighlight.fromJson(h)],
      columns: [for (final c in jMaps(j['columns'])) ReportColumn.fromJson(c)],
      rows: [for (final r in jMaps(j['rows'])) Map<String, Object?>.from(r)],
      totals: totals == null ? null : Map<String, Object?>.from(totals),
      page: jInt(j['page']) == 0 ? 1 : jInt(j['page']),
      pageSize: jInt(j['pageSize']) == 0 ? 50 : jInt(j['pageSize']),
      totalRows: jInt(j['totalRows']),
      notes: jStrings(j['notes']),
    );
  }

  final String kind;
  final String title;
  final String subtitle;

  /// When the server computed these figures.
  final DateTime? generatedAt;
  final String generatedBy;
  final ReportFilterEcho filters;
  final List<ReportHighlight> highlights;
  final List<ReportColumn> columns;
  final List<ReportRow> rows;

  /// Over every row in the filter, never just this page.
  final ReportRow? totals;
  final int page;
  final int pageSize;
  final int totalRows;
  final List<String> notes;

  int get pages => totalRows == 0 ? 1 : (totalRows / pageSize).ceil();
}

/// What a report run asks for. Export sends `all=1` (no paging).
class ReportQuery {
  const ReportQuery({
    required this.kind,
    required this.from,
    required this.to,
    this.zoneId,
    this.vendorId,
    this.vendorName,
    this.riderId,
    this.riderName,
    this.status,
    this.payment,
    this.page = 1,
    this.pageSize = 50,
  });

  final String kind;
  final String from;
  final String to;
  final String? zoneId;
  final String? vendorId;

  /// For the filter chip only; not sent.
  final String? vendorName;
  final String? riderId;
  final String? riderName;
  final String? status;

  /// `cod` or `online`; null = all.
  final String? payment;
  final int page;
  final int pageSize;

  ReportQuery copyWith({
    String? from,
    String? to,
    Object? zoneId = _keep,
    Object? vendorId = _keep,
    Object? vendorName = _keep,
    Object? riderId = _keep,
    Object? riderName = _keep,
    Object? status = _keep,
    Object? payment = _keep,
    int? page,
  }) =>
      ReportQuery(
        kind: kind,
        from: from ?? this.from,
        to: to ?? this.to,
        zoneId: identical(zoneId, _keep) ? this.zoneId : zoneId as String?,
        vendorId: identical(vendorId, _keep) ? this.vendorId : vendorId as String?,
        vendorName: identical(vendorName, _keep) ? this.vendorName : vendorName as String?,
        riderId: identical(riderId, _keep) ? this.riderId : riderId as String?,
        riderName: identical(riderName, _keep) ? this.riderName : riderName as String?,
        status: identical(status, _keep) ? this.status : status as String?,
        payment: identical(payment, _keep) ? this.payment : payment as String?,
        page: page ?? this.page,
        pageSize: pageSize,
      );

  Map<String, String> toQuery({bool all = false}) => {
        'kind': kind,
        'from': from,
        'to': to,
        'zone': ?zoneId,
        'vendor': ?vendorId,
        'rider': ?riderId,
        'status': ?status,
        'payment': ?payment,
        if (all) 'all': '1' else ...{'page': '$page', 'pageSize': '$pageSize'},
      };

  @override
  bool operator ==(Object other) =>
      other is ReportQuery &&
      other.kind == kind &&
      other.from == from &&
      other.to == to &&
      other.zoneId == zoneId &&
      other.vendorId == vendorId &&
      other.riderId == riderId &&
      other.status == status &&
      other.payment == payment &&
      other.page == page &&
      other.pageSize == pageSize;

  @override
  int get hashCode => Object.hash(kind, from, to, zoneId, vendorId, riderId, status, payment, page, pageSize);
}

const _keep = Object();

/// 413 `too_large` — the export would be more than the server allows.
class ReportTooLarge implements Exception {
  const ReportTooLarge({required this.rows, required this.max});
  final int rows;
  final int max;

  @override
  String toString() => 'ReportTooLarge($rows > $max)';
}
