import 'package:image_picker/image_picker.dart' show XFile;
import 'package:uuid/uuid.dart';

import 'json_util.dart';
import 'orders.dart' show TicketPriority, VendorRef;

/// Support tickets as `/api/manager/tickets*` and a vendor's complaints list
/// send them (Phase 4 plan, "Tickets"). Phase 8 adds the queue and metrics on
/// the same shapes.

enum TicketStatus {
  open('open', 'Open'),
  inProgress('in_progress', 'In Progress'),
  waitingOnRequester('waiting_on_requester', 'Waiting on requester'),
  escalated('escalated', 'Escalated'),
  resolved('resolved', 'Resolved'),
  closed('closed', 'Closed'),
  unknown('unknown', 'Unknown');

  const TicketStatus(this.wire, this.label);
  final String wire;
  final String label;

  static TicketStatus parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);

  /// The client's five statuses (§11). The database's sixth,
  /// `waiting_on_requester`, shows as a kind of In Progress.
  String get displayLabel => this == waitingOnRequester ? 'In Progress · waiting on requester' : label;

  bool get isFinal => this == closed;
  bool get isOpen => this == open || this == inProgress || this == waitingOnRequester || this == escalated;
}

enum RequesterRole {
  restaurant('restaurant', 'Vendor'),
  driver('driver', 'Rider'),
  customer('customer', 'Customer'),
  manager('manager', 'Manager'),
  admin('admin', 'Admin'),
  unknown('unknown', 'Unknown');

  const RequesterRole(this.wire, this.label);
  final String wire;
  final String label;

  static RequesterRole parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

class TicketSummary {
  const TicketSummary({
    required this.id,
    required this.number,
    required this.subject,
    required this.category,
    required this.priority,
    required this.status,
    required this.requesterRole,
    this.orderId,
    this.createdAt,
    this.updatedAt,
  });

  factory TicketSummary.fromJson(Map<String, dynamic> j) => TicketSummary(
        id: jStrOr(j['id']),
        number: jInt(j['number']),
        subject: jStrOr(j['subject']),
        category: jStrOr(j['category']),
        priority: TicketPriority.parse(jStr(j['priority'])),
        status: TicketStatus.parse(j['status']),
        requesterRole: RequesterRole.parse(j['requesterRole']),
        orderId: jStr(j['orderId']),
        createdAt: jDate(j['createdAt']),
        updatedAt: jDate(j['updatedAt']),
      );

  final String id;
  final int number;
  final String subject;
  final String category;
  final TicketPriority priority;
  final TicketStatus status;
  final RequesterRole requesterRole;
  final String? orderId;
  final DateTime? createdAt;
  final DateTime? updatedAt;
}

class TicketPage {
  const TicketPage({required this.items, this.nextCursor});
  factory TicketPage.fromJson(Map<String, dynamic> j) => TicketPage(
        items: [for (final t in jMaps(j['items'])) TicketSummary.fromJson(t)],
        nextCursor: jStr(j['nextCursor']),
      );
  final List<TicketSummary> items;
  final String? nextCursor;
}

class TicketAttachment {
  const TicketAttachment({required this.name, required this.url});
  final String name;
  final String url;
}

class TicketAuthor {
  const TicketAuthor({required this.id, required this.name, required this.role});
  final String id;
  final String name;
  final String role;

  bool get isStaff => role == 'manager' || role == 'admin';
}

class TicketMessage {
  const TicketMessage({
    required this.id,
    required this.author,
    required this.body,
    required this.internal,
    required this.attachments,
    this.at,
  });

  factory TicketMessage.fromJson(Map<String, dynamic> j) {
    final a = jMap(j['author']) ?? const {};
    return TicketMessage(
      id: jStrOr(j['id']),
      author: TicketAuthor(id: jStrOr(a['id']), name: jStrOr(a['name'], 'Someone'), role: jStrOr(a['role'])),
      body: jStrOr(j['body']),
      internal: jBool(j['internal']),
      attachments: [
        for (final f in jMaps(j['attachments'])) TicketAttachment(name: jStrOr(f['name'], 'Attachment'), url: jStrOr(f['url'])),
      ],
      at: jDate(j['at']),
    );
  }

  final String id;
  final TicketAuthor author;
  final String body;

  /// An internal note: staff only, never shown to the requester.
  final bool internal;
  final List<TicketAttachment> attachments;
  final DateTime? at;
}

class TicketDetail {
  const TicketDetail({
    required this.summary,
    this.restaurant,
    this.zoneId,
    this.escalationLevel = 0,
    this.resolution,
    this.firstResponseAt,
    this.resolvedAt,
    this.assignee,
    this.team,
    this.requester,
    this.allowedTransitions,
  });

  factory TicketDetail.fromJson(Map<String, dynamic> j) {
    final shop = jRef(j['restaurant']);
    final allowed = j['allowedTransitions'];
    return TicketDetail(
      summary: TicketSummary.fromJson(j),
      restaurant: shop == null ? null : VendorRef(id: shop.id, name: shop.name),
      zoneId: jStr(j['zoneId']),
      escalationLevel: jInt(j['escalationLevel']),
      resolution: jStr(j['resolution']),
      firstResponseAt: jDate(j['firstResponseAt']),
      resolvedAt: jDate(j['resolvedAt']),
      assignee: TicketPerson.maybe(j['assignee']),
      team: TicketTeam.parse(j['team']),
      requester: TicketPerson.maybe(j['requester']),
      allowedTransitions: allowed is List
          ? [
              for (final w in jStrings(allowed))
                if (TicketStatus.parse(w) != TicketStatus.unknown) TicketStatus.parse(w),
            ]
          : null,
    );
  }

  final TicketSummary summary;
  final VendorRef? restaurant;
  final String? zoneId;
  final int escalationLevel;
  final String? resolution;
  final DateTime? firstResponseAt;
  final DateTime? resolvedAt;

  /// Who the ticket is assigned to, and the team (Phase 8).
  final TicketPerson? assignee;
  final TicketTeam? team;
  final TicketPerson? requester;

  /// The statuses the server will accept next. Null from a Phase 4 server,
  /// when the app falls back to its own list.
  final List<TicketStatus>? allowedTransitions;

  /// Escalation goes no higher than this.
  static const maxEscalationLevel = 3;
}

/// Someone on a ticket: the requester, an assignee, the actor of an event.
class TicketPerson {
  const TicketPerson({required this.id, required this.name, this.role = RequesterRole.unknown});

  static TicketPerson? maybe(Object? v) {
    final m = jMap(v);
    if (m == null) return null;
    return TicketPerson(id: jStrOr(m['id']), name: jStrOr(m['name'], 'Someone'), role: RequesterRole.parse(m['role']));
  }

  final String id;
  final String name;
  final RequesterRole role;
}

/// The fixed teams a ticket can sit with.
enum TicketTeam {
  operations('operations', 'Operations'),
  finance('finance', 'Finance'),
  vendorSupport('vendor_support', 'Vendor support'),
  riderSupport('rider_support', 'Rider support'),
  customerSupport('customer_support', 'Customer support');

  const TicketTeam(this.wire, this.label);
  final String wire;
  final String label;

  static TicketTeam? parse(Object? s) {
    for (final t in values) {
      if (t.wire == s) return t;
    }
    return null;
  }
}

enum TicketEventKind {
  created('created'),
  status('status'),
  assigned('assigned'),
  team('team'),
  priority('priority'),
  escalated('escalated'),
  reopened('reopened'),
  firstResponse('first_response'),
  attachment('attachment'),
  unknown('unknown');

  const TicketEventKind(this.wire);
  final String wire;

  static TicketEventKind parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

/// One line of a ticket's history (`events`).
class TicketEvent {
  const TicketEvent({
    required this.id,
    required this.kind,
    this.at,
    this.from,
    this.to,
    this.actor,
    this.reason,
    this.internal = false,
  });

  factory TicketEvent.fromJson(Map<String, dynamic> j) => TicketEvent(
        id: jInt(j['id']),
        kind: TicketEventKind.parse(j['kind']),
        at: jDate(j['at']),
        from: jStr(j['from']),
        to: jStr(j['to']),
        actor: TicketPerson.maybe(j['actor']),
        reason: jStr(j['reason']),
        internal: jBool(j['internal']),
      );

  final int id;
  final TicketEventKind kind;
  final DateTime? at;
  final String? from;
  final String? to;
  final TicketPerson? actor;
  final String? reason;
  final bool internal;
}

/// `GET /api/manager/tickets/[id]`: the ticket and its messages, oldest first.
class TicketThread {
  const TicketThread({required this.ticket, required this.messages, this.events = const []});

  factory TicketThread.fromJson(Map<String, dynamic> j) {
    final messages = [for (final m in jMaps(j['messages'])) TicketMessage.fromJson(m)]
      ..sort((a, b) => (a.at ?? DateTime(0)).compareTo(b.at ?? DateTime(0)));
    final events = [for (final e in jMaps(j['events'])) TicketEvent.fromJson(e)]
      ..sort((a, b) => (a.at ?? DateTime(0)).compareTo(b.at ?? DateTime(0)));
    return TicketThread(
      ticket: TicketDetail.fromJson(jMap(j['ticket']) ?? const {}),
      messages: messages,
      events: events,
    );
  }

  final TicketDetail ticket;
  final List<TicketMessage> messages;

  /// The ticket's history, oldest first (Phase 8).
  final List<TicketEvent> events;
}

const _uuid = Uuid();

/// One write to a ticket. The id is minted once per intent and reused when
/// the manager retries after a network error, so a retry never posts twice.
sealed class TicketWrite {
  TicketWrite({String? clientActionId}) : clientActionId = clientActionId ?? _uuid.v4();
  final String clientActionId;
}

class TicketReply extends TicketWrite {
  TicketReply({required this.body, this.internal = false, this.files = const [], super.clientActionId});
  final String body;
  final bool internal;

  /// Up to [maxFiles] images or PDFs, sent as `files[]` with the reply.
  final List<XFile> files;
  static const maxFiles = 4;

  Map<String, dynamic> toJson() => {'body': body, 'internal': internal, 'clientActionId': clientActionId};
}

class TicketStatusChange extends TicketWrite {
  TicketStatusChange({required this.status, this.resolution, this.reason, super.clientActionId});
  final TicketStatus status;
  final String? resolution;

  /// Required when reopening a resolved ticket.
  final String? reason;

  bool get needsResolution => status == TicketStatus.resolved || status == TicketStatus.closed;

  Map<String, dynamic> toJson() => {
        'status': status.wire,
        if (resolution != null) 'resolution': resolution,
        if (reason != null) 'reason': reason,
        'clientActionId': clientActionId,
      };
}

/// Assign the ticket to someone (or no one) and/or a team.
class TicketAssign extends TicketWrite {
  TicketAssign({this.assigneeId, this.team, super.clientActionId});
  final String? assigneeId;
  final TicketTeam? team;

  Map<String, dynamic> toJson() => {'assigneeId': assigneeId, 'team': team?.wire, 'clientActionId': clientActionId};
}

class TicketPriorityChange extends TicketWrite {
  TicketPriorityChange({required this.priority, required this.reason, super.clientActionId});
  final TicketPriority priority;
  final String reason;

  Map<String, dynamic> toJson() => {'priority': priority.name, 'reason': reason, 'clientActionId': clientActionId};
}

class TicketEscalate extends TicketWrite {
  TicketEscalate({required this.reason, super.clientActionId});
  final String reason;

  Map<String, dynamic> toJson() => {'reason': reason, 'clientActionId': clientActionId};
}
