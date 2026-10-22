import 'package:intl/intl.dart';

import 'json_util.dart';
import 'orders.dart' show TicketPriority, VendorRef;
import 'tickets.dart';

/// The support queue (§11) as `/api/manager/tickets` sends it: Phase 4's
/// ticket summary plus who has it, how old it is and whether anyone has
/// answered yet.
class TicketListItem {
  const TicketListItem({
    required this.summary,
    this.zoneId,
    this.restaurant,
    this.requester,
    this.assignee,
    this.team,
    this.escalationLevel = 0,
    this.firstResponseAt,
    this.resolvedAt,
    this.ageMinutes = 0,
    this.awaitingFirstResponse = false,
    this.unreadForStaff = 0,
  });

  factory TicketListItem.fromJson(Map<String, dynamic> j) {
    final shop = jRef(j['restaurant']);
    return TicketListItem(
      summary: TicketSummary.fromJson(j),
      zoneId: jStr(j['zoneId']),
      restaurant: shop == null ? null : VendorRef(id: shop.id, name: shop.name),
      requester: TicketPerson.maybe(j['requester']),
      assignee: TicketPerson.maybe(j['assignee']),
      team: TicketTeam.parse(j['team']),
      escalationLevel: jInt(j['escalationLevel']),
      firstResponseAt: jDate(j['firstResponseAt']),
      resolvedAt: jDate(j['resolvedAt']),
      ageMinutes: jInt(j['ageMinutes']),
      awaitingFirstResponse: jBool(j['awaitingFirstResponse']),
      unreadForStaff: jInt(j['unreadForStaff']),
    );
  }

  final TicketSummary summary;
  final String? zoneId;
  final VendorRef? restaurant;
  final TicketPerson? requester;
  final TicketPerson? assignee;
  final TicketTeam? team;
  final int escalationLevel;
  final DateTime? firstResponseAt;
  final DateTime? resolvedAt;
  final int ageMinutes;
  final bool awaitingFirstResponse;
  final int unreadForStaff;

  String get id => summary.id;
}

/// Per-status counts sent with every page of the queue.
class TicketCounts {
  const TicketCounts({
    this.open = 0,
    this.inProgress = 0,
    this.waitingOnRequester = 0,
    this.escalated = 0,
    this.resolved = 0,
    this.closed = 0,
    this.unassigned = 0,
    this.mine = 0,
  });

  factory TicketCounts.fromJson(Map<String, dynamic>? j) => TicketCounts(
        open: jInt(j?['open']),
        inProgress: jInt(j?['in_progress']),
        waitingOnRequester: jInt(j?['waiting_on_requester']),
        escalated: jInt(j?['escalated']),
        resolved: jInt(j?['resolved']),
        closed: jInt(j?['closed']),
        unassigned: jInt(j?['unassigned']),
        mine: jInt(j?['mine']),
      );

  final int open;
  final int inProgress;
  final int waitingOnRequester;
  final int escalated;
  final int resolved;
  final int closed;
  final int unassigned;
  final int mine;

  /// Not yet resolved or closed.
  int get active => open + inProgress + waitingOnRequester + escalated;

  int of(TicketQueue q) => switch (q) {
        TicketQueue.active => active,
        TicketQueue.escalated => escalated,
        TicketQueue.unassigned => unassigned,
        TicketQueue.mine => mine,
        TicketQueue.resolved => resolved,
        TicketQueue.closed => closed,
      };
}

class TicketListPage {
  const TicketListPage({required this.items, required this.counts, this.nextCursor});

  factory TicketListPage.fromJson(Map<String, dynamic> j) => TicketListPage(
        items: [for (final t in jMaps(j['items'])) TicketListItem.fromJson(t)],
        counts: TicketCounts.fromJson(jMap(j['counts'])),
        nextCursor: jStr(j['nextCursor']),
      );

  final List<TicketListItem> items;
  final TicketCounts counts;
  final String? nextCursor;
}

/// The queue's chips. Each one is a set of filters, not a separate list.
enum TicketQueue {
  active('Active'),
  escalated('Escalated'),
  unassigned('Unassigned'),
  mine('Mine'),
  resolved('Resolved'),
  closed('Closed');

  const TicketQueue(this.label);
  final String label;
}

final _day = DateFormat('yyyy-MM-dd');

/// What the support queue is showing. [statuses] holds database statuses or
/// `active`; [assignee] is `me`, `unassigned` or a staff id.
class TicketFilters {
  const TicketFilters({
    this.statuses = const {'active'},
    this.category,
    this.priorities = const {},
    this.requesterRoles = const {},
    this.from,
    this.to,
    this.zoneId,
    this.assignee,
    this.team,
    this.vendorId,
    this.riderId,
    this.q,
  });

  /// The filters for one chip, keeping the sheet's narrowing.
  factory TicketFilters.forQueue(TicketQueue q, [TicketFilters base = const TicketFilters()]) => switch (q) {
        TicketQueue.active => base.copyWith(statuses: const {'active'}, assignee: null),
        TicketQueue.escalated => base.copyWith(statuses: const {'escalated'}, assignee: null),
        TicketQueue.unassigned => base.copyWith(statuses: const {'active'}, assignee: 'unassigned'),
        TicketQueue.mine => base.copyWith(statuses: const {'active'}, assignee: 'me'),
        TicketQueue.resolved => base.copyWith(statuses: const {'resolved'}, assignee: null),
        TicketQueue.closed => base.copyWith(statuses: const {'closed'}, assignee: null),
      };

  /// Reads the query this produced (and deep links such as
  /// `/more/support?category=payment`).
  factory TicketFilters.fromQuery(Map<String, String> p) {
    String? s(String k) => (p[k]?.trim().isEmpty ?? true) ? null : p[k]!.trim();
    Set<String> list(String k) => {for (final w in (p[k] ?? '').split(',')) if (w.trim().isNotEmpty) w.trim()};
    final statuses = list('status');
    return TicketFilters(
      statuses: statuses.isEmpty ? const {'active'} : statuses,
      category: s('category'),
      priorities: list('priority'),
      requesterRoles: list('requesterRole'),
      from: s('from') == null ? null : DateTime.tryParse(s('from')!),
      to: s('to') == null ? null : DateTime.tryParse(s('to')!),
      zoneId: s('zone'),
      assignee: s('assignee'),
      team: TicketTeam.parse(s('team')),
      vendorId: s('vendor'),
      riderId: s('rider'),
      q: s('q'),
    );
  }

  final Set<String> statuses;
  final String? category;
  final Set<String> priorities;
  final Set<String> requesterRoles;
  final DateTime? from;
  final DateTime? to;
  final String? zoneId;
  final String? assignee;
  final TicketTeam? team;
  final String? vendorId;
  final String? riderId;
  final String? q;

  static String _join(Set<String> s) => (s.toList()..sort()).join(',');

  Map<String, String> toQuery() => {
        if (statuses.isNotEmpty) 'status': _join(statuses),
        'category': ?category,
        if (priorities.isNotEmpty) 'priority': _join(priorities),
        if (requesterRoles.isNotEmpty) 'requesterRole': _join(requesterRoles),
        'assignee': ?assignee,
        'team': ?team?.wire,
        'vendor': ?vendorId,
        'rider': ?riderId,
        'zone': ?zoneId,
        'q': ?q,
        if (from != null) 'from': _day.format(from!),
        if (to != null) 'to': _day.format(to!),
      };

  /// The chip these filters correspond to, if any.
  TicketQueue? get queue {
    final st = statuses.length == 1 ? statuses.first : null;
    return switch ((st, assignee)) {
      ('active', null) => TicketQueue.active,
      ('active', 'unassigned') => TicketQueue.unassigned,
      ('active', 'me') => TicketQueue.mine,
      ('escalated', null) => TicketQueue.escalated,
      ('resolved', null) => TicketQueue.resolved,
      ('closed', null) => TicketQueue.closed,
      _ => null,
    };
  }

  /// How many sheet filters are on (the badge on the Filters button).
  int get sheetCount => [
        category,
        if (priorities.isNotEmpty) 'p',
        if (requesterRoles.isNotEmpty) 'r',
        if (from != null || to != null) 'd',
        team,
        vendorId,
        riderId,
      ].whereType<Object>().length;

  bool get narrowed => sheetCount > 0 || q != null;

  static const _unset = Object();

  TicketFilters copyWith({
    Set<String>? statuses,
    Object? category = _unset,
    Set<String>? priorities,
    Set<String>? requesterRoles,
    Object? from = _unset,
    Object? to = _unset,
    Object? zoneId = _unset,
    Object? assignee = _unset,
    Object? team = _unset,
    Object? vendorId = _unset,
    Object? riderId = _unset,
    Object? q = _unset,
  }) =>
      TicketFilters(
        statuses: statuses ?? this.statuses,
        category: identical(category, _unset) ? this.category : category as String?,
        priorities: priorities ?? this.priorities,
        requesterRoles: requesterRoles ?? this.requesterRoles,
        from: identical(from, _unset) ? this.from : from as DateTime?,
        to: identical(to, _unset) ? this.to : to as DateTime?,
        zoneId: identical(zoneId, _unset) ? this.zoneId : zoneId as String?,
        assignee: identical(assignee, _unset) ? this.assignee : assignee as String?,
        team: identical(team, _unset) ? this.team : team as TicketTeam?,
        vendorId: identical(vendorId, _unset) ? this.vendorId : vendorId as String?,
        riderId: identical(riderId, _unset) ? this.riderId : riderId as String?,
        q: identical(q, _unset) ? this.q : q as String?,
      );

  @override
  bool operator ==(Object other) =>
      other is TicketFilters && other.toQuery().toString() == toQuery().toString();

  @override
  int get hashCode => toQuery().toString().hashCode;
}

/// An average and a median, in minutes, over [count] tickets.
class MinutesFigure {
  const MinutesFigure({this.avgMinutes, this.medianMinutes, this.count = 0});

  factory MinutesFigure.fromJson(Map<String, dynamic>? j) => MinutesFigure(
        avgMinutes: jDoubleOrNull(j?['avgMinutes']),
        medianMinutes: jDoubleOrNull(j?['medianMinutes']),
        count: jInt(j?['count']),
      );

  final double? avgMinutes;
  final double? medianMinutes;
  final int count;
}

/// One row of a recurring-problems list: a category, vendor, rider, zone or
/// repeated order, with how many tickets and what share of the range.
class RecurringRow {
  const RecurringRow({required this.id, required this.label, required this.count, this.share, this.code});

  factory RecurringRow.fromJson(Map<String, dynamic> j) => RecurringRow(
        id: jStrOr(j['id'], jStrOr(j['key'])),
        label: jStrOr(j['label'], jStrOr(j['name'], jStrOr(j['code']))),
        count: jInt(j['count']),
        share: jDoubleOrNull(j['share']),
        code: jStr(j['code']),
      );

  final String id;
  final String label;
  final int count;
  final double? share;
  final String? code;
}

class DailyTickets {
  const DailyTickets({required this.date, required this.created, required this.resolved});
  final DateTime date;
  final int created;
  final int resolved;
}

/// `/api/manager/tickets/metrics`: response and resolution times and the
/// problems that keep coming back (§11.10, §11.11).
class TicketMetrics {
  const TicketMetrics({
    required this.from,
    required this.to,
    this.created = 0,
    this.resolved = 0,
    this.reopened = 0,
    this.openOverSla = 0,
    this.firstResponse = const MinutesFigure(),
    this.resolution = const MinutesFigure(),
    this.recurringCategories = const [],
    this.recurringVendors = const [],
    this.recurringRiders = const [],
    this.recurringZones = const [],
    this.recurringOrders = const [],
    this.daily = const [],
    this.generatedAt,
  });

  factory TicketMetrics.fromJson(Map<String, dynamic> j) {
    final range = jMap(j['range']);
    final rec = jMap(j['recurring']) ?? const {};
    List<RecurringRow> rows(String k) => [for (final r in jMaps(rec[k])) RecurringRow.fromJson(r)];
    return TicketMetrics(
      from: DateTime.tryParse(jStrOr(range?['from'])),
      to: DateTime.tryParse(jStrOr(range?['to'])),
      created: jInt(j['created']),
      resolved: jInt(j['resolved']),
      reopened: jInt(j['reopened']),
      openOverSla: jInt(j['openOverSla']),
      firstResponse: MinutesFigure.fromJson(jMap(j['firstResponse'])),
      resolution: MinutesFigure.fromJson(jMap(j['resolution'])),
      recurringCategories: rows('categories'),
      recurringVendors: rows('vendors'),
      recurringRiders: rows('riders'),
      recurringZones: rows('zones'),
      recurringOrders: rows('orders'),
      daily: [
        for (final d in jMaps(j['daily']))
          if (DateTime.tryParse(jStrOr(d['date'])) case final date?)
            DailyTickets(date: date, created: jInt(d['created']), resolved: jInt(d['resolved'])),
      ],
      generatedAt: jDate(j['generatedAt']),
    );
  }

  final DateTime? from;
  final DateTime? to;
  final int created;
  final int resolved;
  final int reopened;
  final int openOverSla;
  final MinutesFigure firstResponse;
  final MinutesFigure resolution;
  final List<RecurringRow> recurringCategories;
  final List<RecurringRow> recurringVendors;
  final List<RecurringRow> recurringRiders;
  final List<RecurringRow> recurringZones;
  final List<RecurringRow> recurringOrders;
  final List<DailyTickets> daily;
  final DateTime? generatedAt;
}

/// Someone a ticket can be assigned to, with how many open tickets they hold.
class Assignee {
  const Assignee({required this.id, required this.name, required this.role, this.openAssigned = 0});

  factory Assignee.fromJson(Map<String, dynamic> j) => Assignee(
        id: jStrOr(j['id']),
        name: jStrOr(j['name'], 'Someone'),
        role: jStrOr(j['role'], 'manager'),
        openAssigned: jInt(j['openAssigned']),
      );

  final String id;
  final String name;
  final String role;
  final int openAssigned;
}

class AssigneeList {
  const AssigneeList({required this.staff, required this.teams});

  factory AssigneeList.fromJson(Map<String, dynamic> j) => AssigneeList(
        staff: [for (final s in jMaps(j['staff'])) Assignee.fromJson(s)],
        teams: [for (final t in jStrings(j['teams'])) ?TicketTeam.parse(t)],
      );

  final List<Assignee> staff;
  final List<TicketTeam> teams;
}

/// "22 min", "6 h 50 min", "2 d 3 h" — or "—" when there is nothing to average.
String minutesLabel(double? m) {
  if (m == null) return '—';
  final total = m.round();
  if (total < 60) return '$total min';
  if (total < 60 * 24) {
    final h = total ~/ 60, r = total % 60;
    return r == 0 ? '$h h' : '$h h $r min';
  }
  final d = total ~/ (60 * 24), h = (total % (60 * 24)) ~/ 60;
  return h == 0 ? '$d d' : '$d d $h h';
}

/// "normal" → TicketPriority.normal for the filter chips.
TicketPriority priorityFromWire(String w) => TicketPriority.parse(w);
