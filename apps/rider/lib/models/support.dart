/// Help desk and safety shapes, as `/api/rider/support/*` and `/api/rider/sos`
/// send them (src/lib/data-access/support.ts, sos.ts). English only.
library;

export 'emergency_contact.dart';

DateTime? _date(Object? v) => v is String ? DateTime.tryParse(v)?.toLocal() : null;

String _s(Object? v, [String fallback = '']) => v is String ? v : fallback;

Map<String, dynamic> _map(Object? v) =>
    v is Map ? Map<String, dynamic>.from(v) : const <String, dynamic>{};

String? _nonEmpty(Object? v) => v is String && v.trim().isNotEmpty ? v.trim() : null;

/// A ticket category the rider can pick: the key the server takes and the
/// words to show.
class SupportCategory {
  const SupportCategory(this.key, this.label);

  final String key;
  final String label;

  factory SupportCategory.fromJson(Map<String, dynamic> j) =>
      SupportCategory(_s(j['key']), _s(j['label'], _s(j['key'])));
}

/// Deligro's support numbers (platform settings). Either can be missing.
class SupportContact {
  const SupportContact({this.phone, this.whatsapp});

  final String? phone;
  final String? whatsapp;

  bool get hasPhone => (phone ?? '').trim().isNotEmpty;
  bool get hasWhatsapp => (whatsapp ?? '').trim().isNotEmpty;

  static const none = SupportContact();

  factory SupportContact.fromJson(Object? j) {
    final m = _map(j);
    return SupportContact(phone: _nonEmpty(m['phone']), whatsapp: _nonEmpty(m['whatsapp']));
  }

  Map<String, dynamic> toJson() => {'phone': phone, 'whatsapp': whatsapp};
}

/// One row of the tickets list.
class TicketSummary {
  const TicketSummary({
    required this.id,
    required this.number,
    required this.category,
    required this.categoryLabel,
    required this.priority,
    required this.subject,
    required this.status,
    required this.statusLabel,
    this.orderId,
    this.orderCode,
    this.createdAt,
    this.updatedAt,
    this.resolvedAt,
  });

  final String id;
  final int number;
  final String category;
  final String categoryLabel;

  /// `normal` | `high` | `emergency`.
  final String priority;
  final String subject;

  /// `open` | `in_progress` | `waiting_on_requester` | `escalated` |
  /// `resolved` | `closed`.
  final String status;
  final String statusLabel;
  final String? orderId;
  final String? orderCode;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final DateTime? resolvedAt;

  bool get isEmergency => priority == 'emergency';
  bool get isClosed => status == 'resolved' || status == 'closed';
  bool get waitingOnRider => status == 'waiting_on_requester';

  factory TicketSummary.fromJson(Map<String, dynamic> j) => TicketSummary(
        id: _s(j['id']),
        number: (j['number'] as num?)?.toInt() ?? 0,
        category: _s(j['category']),
        categoryLabel: _s(j['categoryLabel'], _s(j['category'])),
        priority: _s(j['priority'], 'normal'),
        subject: _s(j['subject']),
        status: _s(j['status'], 'open'),
        statusLabel: _s(j['statusLabel'], _s(j['status'])),
        orderId: j['orderId'] as String?,
        orderCode: j['orderCode'] as String?,
        createdAt: _date(j['createdAt']),
        updatedAt: _date(j['updatedAt']),
        resolvedAt: _date(j['resolvedAt']),
      );
}

/// A ticket opened on its own: the summary and where the rider was.
class TicketDetail extends TicketSummary {
  const TicketDetail({
    required super.id,
    required super.number,
    required super.category,
    required super.categoryLabel,
    required super.priority,
    required super.subject,
    required super.status,
    required super.statusLabel,
    super.orderId,
    super.orderCode,
    super.createdAt,
    super.updatedAt,
    super.resolvedAt,
    this.locationUrl,
  });

  final String? locationUrl;

  factory TicketDetail.fromJson(Map<String, dynamic> j) {
    final s = TicketSummary.fromJson(j);
    return TicketDetail(
      id: s.id,
      number: s.number,
      category: s.category,
      categoryLabel: s.categoryLabel,
      priority: s.priority,
      subject: s.subject,
      status: s.status,
      statusLabel: s.statusLabel,
      orderId: s.orderId,
      orderCode: s.orderCode,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      resolvedAt: s.resolvedAt,
      locationUrl: j['locationUrl'] as String?,
    );
  }
}

class TicketMessage {
  const TicketMessage({
    required this.id,
    required this.body,
    required this.fromStaff,
    this.authorRole = '',
    this.photoUrls = const [],
    this.createdAt,
  });

  final String id;
  final String body;

  /// Written by Deligro (admin or manager), not by the rider.
  final bool fromStaff;
  final String authorRole;

  /// 10-minute signed links; an entry the server could not sign is left out.
  final List<String> photoUrls;
  final DateTime? createdAt;

  factory TicketMessage.fromJson(Map<String, dynamic> j) => TicketMessage(
        id: _s(j['id']),
        body: _s(j['body']),
        fromStaff: j['fromStaff'] == true,
        authorRole: _s(j['authorRole']),
        photoUrls: [
          for (final a in (j['attachments'] as List? ?? const []))
            if (a is Map && a['url'] is String) a['url'] as String,
        ],
        createdAt: _date(j['createdAt']),
      );
}

class TicketThread {
  const TicketThread({required this.ticket, required this.messages});

  final TicketDetail ticket;
  final List<TicketMessage> messages;

  factory TicketThread.fromJson(Map<String, dynamic> j) => TicketThread(
        ticket: TicketDetail.fromJson(_map(j['ticket'])),
        messages: [
          for (final m in (j['messages'] as List? ?? const []))
            // The server never sends internal notes; one that slipped through
            // would still not be shown.
            if (m is Map && m['internal'] != true) TicketMessage.fromJson(Map<String, dynamic>.from(m)),
        ],
      );
}

/// `GET /api/rider/support/tickets`: the tickets, the numbers to call and the
/// category lists in the document's order.
class SupportOverview {
  const SupportOverview({
    required this.tickets,
    required this.contact,
    required this.categories,
    this.safetyCategories = const [],
  });

  final List<TicketSummary> tickets;
  final SupportContact contact;
  final List<SupportCategory> categories;
  final List<SupportCategory> safetyCategories;

  factory SupportOverview.fromJson(Map<String, dynamic> j) {
    List<SupportCategory> cats(Object? v) => [
          for (final c in (v as List? ?? const []))
            if (c is Map) SupportCategory.fromJson(Map<String, dynamic>.from(c)),
        ];
    return SupportOverview(
      tickets: [
        for (final t in (j['tickets'] as List? ?? const []))
          if (t is Map) TicketSummary.fromJson(Map<String, dynamic>.from(t)),
      ],
      contact: SupportContact.fromJson(j['contact']),
      categories: cats(j['categories']),
      safetyCategories: cats(j['safetyCategories']),
    );
  }
}

/// What `POST /api/rider/support/tickets` answered.
class CreatedTicket {
  const CreatedTicket({required this.id, required this.number, required this.priority});

  final String id;
  final int number;
  final String priority;

  factory CreatedTicket.fromJson(Map<String, dynamic> j) => CreatedTicket(
        id: _s(j['id']),
        number: (j['number'] as num?)?.toInt() ?? 0,
        priority: _s(j['priority'], 'normal'),
      );
}

/// A recent delivery the rider can link a ticket to.
class RecentOrder {
  const RecentOrder({required this.orderId, required this.code, this.shop});

  final String orderId;
  final String code;
  final String? shop;

  factory RecentOrder.fromJson(Map<String, dynamic> j) =>
      RecentOrder(orderId: _s(j['orderId']), code: _s(j['code']), shop: j['shop'] as String?);
}

/// The kinds `POST /api/rider/sos` takes.
enum SosKind {
  alert('alert', 'SOS'),
  unsafeSituation('unsafe_situation', 'Unsafe situation'),
  accident('accident', 'Accident'),
  vehicleBreakdown('vehicle_breakdown', 'Vehicle breakdown'),
  harassmentThreat('harassment_threat', 'Harassment or threats'),
  suspiciousOrderLocation('suspicious_order_location', 'Suspicious order or location');

  const SosKind(this.wire, this.label);

  final String wire;
  final String label;

  static SosKind? parse(Object? v) {
    for (final k in values) {
      if (k.wire == v) return k;
    }
    return null;
  }

  /// The five report forms on the Safety screen.
  static const reports = [
    unsafeSituation,
    accident,
    vehicleBreakdown,
    harassmentThreat,
    suspiciousOrderLocation,
  ];
}

/// What the server answered to an SOS that it took (200 or 201).
class SosAck {
  const SosAck({required this.ticketId, required this.number, required this.deduped});

  final String ticketId;
  final int number;

  /// Added to the rider's emergency from the last 10 minutes.
  final bool deduped;

  factory SosAck.fromJson(Map<String, dynamic> j) => SosAck(
        ticketId: _s(j['ticketId']),
        number: (j['number'] as num?)?.toInt() ?? 0,
        deduped: j['deduped'] == true,
      );
}
