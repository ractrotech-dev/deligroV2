import 'package:uuid/uuid.dart';

import 'json_util.dart';
import 'orders.dart' show TicketPriority, VendorRef;

/// Support tickets as `/api/manager/tickets*` and a vendor's complaints list
/// send them (Phase 4 plan, "Tickets"). Phase 8 adds the queue and metrics on
/// the same shapes.

enum TicketStatus {
  open('open', 'Open'),
  inProgress('in_progress', 'In progress'),
  waitingOnRequester('waiting_on_requester', 'Waiting on requester'),
  escalated('escalated', 'Escalated'),
  resolved('resolved', 'Resolved'),
  closed('closed', 'Closed'),
  unknown('unknown', 'Unknown');

  const TicketStatus(this.wire, this.label);
  final String wire;
  final String label;

  static TicketStatus parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);

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
  });

  factory TicketDetail.fromJson(Map<String, dynamic> j) {
    final shop = jRef(j['restaurant']);
    return TicketDetail(
      summary: TicketSummary.fromJson(j),
      restaurant: shop == null ? null : VendorRef(id: shop.id, name: shop.name),
      zoneId: jStr(j['zoneId']),
      escalationLevel: jInt(j['escalationLevel']),
      resolution: jStr(j['resolution']),
      firstResponseAt: jDate(j['firstResponseAt']),
      resolvedAt: jDate(j['resolvedAt']),
    );
  }

  final TicketSummary summary;
  final VendorRef? restaurant;
  final String? zoneId;
  final int escalationLevel;
  final String? resolution;
  final DateTime? firstResponseAt;
  final DateTime? resolvedAt;
}

/// `GET /api/manager/tickets/[id]`: the ticket and its messages, oldest first.
class TicketThread {
  const TicketThread({required this.ticket, required this.messages});

  factory TicketThread.fromJson(Map<String, dynamic> j) {
    final messages = [for (final m in jMaps(j['messages'])) TicketMessage.fromJson(m)]
      ..sort((a, b) => (a.at ?? DateTime(0)).compareTo(b.at ?? DateTime(0)));
    return TicketThread(ticket: TicketDetail.fromJson(jMap(j['ticket']) ?? const {}), messages: messages);
  }

  final TicketDetail ticket;
  final List<TicketMessage> messages;
}

const _uuid = Uuid();

/// One write to a ticket. The id is minted once per intent and reused when
/// the manager retries after a network error, so a retry never posts twice.
sealed class TicketWrite {
  TicketWrite({String? clientActionId}) : clientActionId = clientActionId ?? _uuid.v4();
  final String clientActionId;
}

class TicketReply extends TicketWrite {
  TicketReply({required this.body, this.internal = false, super.clientActionId});
  final String body;
  final bool internal;

  Map<String, dynamic> toJson() => {'body': body, 'internal': internal, 'clientActionId': clientActionId};
}

class TicketStatusChange extends TicketWrite {
  TicketStatusChange({required this.status, this.resolution, super.clientActionId});
  final TicketStatus status;
  final String? resolution;

  bool get needsResolution => status == TicketStatus.resolved || status == TicketStatus.closed;

  Map<String, dynamic> toJson() => {
        'status': status.wire,
        if (resolution != null) 'resolution': resolution,
        'clientActionId': clientActionId,
      };
}
