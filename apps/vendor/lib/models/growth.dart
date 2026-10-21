/// Offers, reviews & insights, marketing requests, support tickets and the
/// notification inbox (src/app/api/vendor/{offers,reviews,marketing,support,notifications}).
library;

int _n(Object? v) => (v as num?)?.round() ?? 0;
int? _nn(Object? v) => (v as num?)?.round();
DateTime? _d(Object? v) => DateTime.tryParse('${v ?? ''}')?.toLocal();
List<Map<String, dynamic>> _list(Object? v) => [
  for (final x in (v as List? ?? const [])) (x as Map).cast<String, dynamic>(),
];
Map<String, dynamic> _map(Object? v) => ((v as Map?) ?? const {}).cast<String, dynamic>();

// ---- Offers ----

class OfferImpact {
  const OfferImpact({this.orders = 0, this.sales = 0, this.discount = 0, this.earningsCost = 0});
  factory OfferImpact.fromJson(Map<String, dynamic> j) => OfferImpact(
    orders: _n(j['orders']),
    sales: _n(j['sales']),
    discount: _n(j['discount']),
    earningsCost: _n(j['earningsCost']),
  );
  final int orders;
  final int sales;
  final int discount;

  /// What the discount took out of the shop's earnings (0 for Deligro's).
  final int earningsCost;
}

class Offer {
  const Offer({
    required this.code,
    this.label,
    required this.kind,
    required this.value,
    this.minOrder = 0,
    this.maxDiscount,
    this.active = true,
    this.startsAt,
    this.expiresAt,
    this.maxPerCustomer,
    this.maxRedemptions,
    this.redemptions = 0,
    this.status = 'live',
    this.impact = const OfferImpact(),
  });

  factory Offer.fromJson(Map<String, dynamic> j) => Offer(
    code: '${j['code']}',
    label: j['label'] as String?,
    kind: '${j['kind'] ?? 'percent'}',
    value: _n(j['value']),
    minOrder: _n(j['minOrder']),
    maxDiscount: _nn(j['maxDiscount']),
    active: j['active'] != false,
    startsAt: _d(j['startsAt']),
    expiresAt: _d(j['expiresAt']),
    maxPerCustomer: _nn(j['maxPerCustomer']),
    maxRedemptions: _nn(j['maxRedemptions']),
    redemptions: _n(j['redemptions']),
    status: '${j['status'] ?? 'live'}',
    impact: OfferImpact.fromJson(_map(j['impact'])),
  );

  final String code;
  final String? label;

  /// `percent` or `flat`.
  final String kind;
  final int value;
  final int minOrder;
  final int? maxDiscount;
  final bool active;
  final DateTime? startsAt;
  final DateTime? expiresAt;
  final int? maxPerCustomer;
  final int? maxRedemptions;
  final int redemptions;

  /// live, scheduled, expired, paused, used_up.
  final String status;
  final OfferImpact impact;

  /// "20% OFF up to ₹80 over ₹199" — the badge customers see.
  String get headline {
    final amount = kind == 'percent' ? '$value% OFF' : '₹$value OFF';
    final cap = kind == 'percent' && maxDiscount != null ? ' up to ₹$maxDiscount' : '';
    final min = minOrder > 0 ? ' over ₹$minOrder' : '';
    return '$amount$cap$min';
  }

  Map<String, Object?> toJson() => {
    'code': code,
    'label': label,
    'kind': kind,
    'value': value,
    'minOrder': minOrder,
    'maxDiscount': kind == 'percent' ? maxDiscount : null,
    'active': active,
    'startsAt': startsAt?.toUtc().toIso8601String(),
    'expiresAt': expiresAt?.toUtc().toIso8601String(),
    'maxPerCustomer': maxPerCustomer,
    'maxRedemptions': maxRedemptions,
  };
}

class PlatformOffer {
  const PlatformOffer({required this.offer, required this.shopOnly});
  factory PlatformOffer.fromJson(Map<String, dynamic> j) =>
      PlatformOffer(offer: Offer.fromJson(j), shopOnly: j['shopOnly'] == true);
  final Offer offer;
  final bool shopOnly;
}

class OffersState {
  const OffersState({required this.own, required this.platform});
  factory OffersState.fromJson(Map<String, dynamic> j) => OffersState(
    own: _list(j['own']).map(Offer.fromJson).toList(),
    platform: _list(j['platform']).map(PlatformOffer.fromJson).toList(),
  );
  final List<Offer> own;
  final List<PlatformOffer> platform;
}

// ---- Reviews & insights ----

class Review {
  const Review({
    required this.id,
    required this.orderCode,
    required this.rating,
    this.comment,
    required this.createdAt,
    this.details = const [],
    this.reply,
  });

  factory Review.fromJson(Map<String, dynamic> j) {
    final reply = (j['reply'] as Map?)?.cast<String, dynamic>();
    return Review(
      id: '${j['id']}',
      orderCode: '${j['orderCode'] ?? ''}',
      rating: _n(j['rating']),
      comment: j['comment'] as String?,
      createdAt: _d(j['createdAt']),
      details: [for (final d in _list(j['details'])) (label: '${d['label']}', value: _n(d['value']))],
      reply: reply == null ? null : '${reply['text'] ?? ''}',
    );
  }

  final String id;
  final String orderCode;
  final int rating;
  final String? comment;
  final DateTime? createdAt;
  final List<({String label, int value})> details;
  final String? reply;
}

class TopCustomer {
  const TopCustomer({required this.name, required this.orders, required this.spent, this.lastOrderAt});
  factory TopCustomer.fromJson(Map<String, dynamic> j) => TopCustomer(
    name: '${j['name']}',
    orders: _n(j['orders']),
    spent: _n(j['spent']),
    lastOrderAt: _d(j['lastOrderAt']),
  );
  final String name;
  final int orders;
  final int spent;
  final DateTime? lastOrderAt;
}

class Insights {
  const Insights({
    required this.customers,
    required this.repeatCustomers,
    required this.repeatRate,
    required this.ordersPerCustomer,
    required this.averageOrderValue,
    this.daysBetweenOrders,
    this.topCustomers = const [],
    this.topProducts = const [],
  });

  factory Insights.fromJson(Map<String, dynamic> j) => Insights(
    customers: _n(j['customers']),
    repeatCustomers: _n(j['repeatCustomers']),
    repeatRate: (j['repeatRate'] as num?)?.toDouble() ?? 0,
    ordersPerCustomer: (j['ordersPerCustomer'] as num?)?.toDouble() ?? 0,
    averageOrderValue: _n(j['averageOrderValue']),
    daysBetweenOrders: (j['daysBetweenOrders'] as num?)?.toDouble(),
    topCustomers: _list(j['topCustomers']).map(TopCustomer.fromJson).toList(),
    topProducts: [
      for (final p in _list(j['topProducts'])) (name: '${p['name']}', qty: _n(p['qty']), orders: _n(p['orders'])),
    ],
  );

  final int customers;
  final int repeatCustomers;
  final double repeatRate;
  final double ordersPerCustomer;
  final int averageOrderValue;
  final double? daysBetweenOrders;
  final List<TopCustomer> topCustomers;

  /// Most ordered dishes in the window (requirements §10.5).
  final List<({String name, int qty, int orders})> topProducts;
}

class ReviewsState {
  const ReviewsState({
    required this.average,
    required this.count,
    required this.reviews,
    required this.stars,
    required this.insights,
    required this.days,
  });

  factory ReviewsState.fromJson(Map<String, dynamic> j) => ReviewsState(
    average: (j['average'] as num?)?.toDouble(),
    count: _n(j['count']),
    reviews: _list(j['reviews']).map(Review.fromJson).toList(),
    stars: {for (final s in _list(j['stars'])) _n(s['stars']): _n(s['count'])},
    insights: Insights.fromJson(_map(j['insights'])),
    days: _n(j['days']),
  );

  final double? average;
  final int count;
  final List<Review> reviews;

  /// Stars → how many of the reviews shown gave that many.
  final Map<int, int> stars;
  final Insights insights;
  final int days;
}

// ---- Marketing requests ----

/// The client's five request types (requirements §6).
const marketingKinds = {
  'featured': 'Featured store listing',
  'banner': 'Banner advertisement',
  'discount_offer': 'Discount & offer promotion',
  'festival_campaign': 'Festival / seasonal campaign',
  'sponsored_product': 'Sponsored product promotion',
};

class MarketingUpdate {
  const MarketingUpdate({required this.status, this.remarks, required this.byDeligro, this.at});
  factory MarketingUpdate.fromJson(Map<String, dynamic> j) => MarketingUpdate(
    status: '${j['status']}',
    remarks: j['remarks'] as String?,
    byDeligro: j['by'] == 'deligro',
    at: _d(j['at']),
  );
  final String status;
  final String? remarks;
  final bool byDeligro;
  final DateTime? at;
}

class MarketingRequest {
  const MarketingRequest({
    required this.id,
    required this.number,
    required this.kind,
    required this.title,
    required this.details,
    this.budget,
    this.startsOn,
    this.endsOn,
    required this.status,
    this.adminRemarks,
    this.createdAt,
    this.updates = const [],
  });

  factory MarketingRequest.fromJson(Map<String, dynamic> j) => MarketingRequest(
    id: '${j['id']}',
    number: _n(j['number']),
    kind: '${j['kind']}',
    title: '${j['title']}',
    details: '${j['details']}',
    budget: _nn(j['budget']),
    startsOn: j['startsOn'] as String?,
    endsOn: j['endsOn'] as String?,
    status: '${j['status']}',
    adminRemarks: j['adminRemarks'] as String?,
    createdAt: _d(j['createdAt']),
    updates: _list(j['updates']).map(MarketingUpdate.fromJson).toList(),
  );

  final String id;
  final int number;
  final String kind;
  final String title;
  final String details;
  final int? budget;
  final String? startsOn;
  final String? endsOn;

  /// pending, approved, in_progress, completed, rejected, cancelled.
  final String status;
  final String? adminRemarks;
  final DateTime? createdAt;
  final List<MarketingUpdate> updates;

  String get kindLabel => marketingKinds[kind] ?? kind;
}

// ---- Support ----

/// The client's issue categories (requirements §12).
const ticketCategories = {
  'payments': 'Payment or settlement',
  'commission': 'Incorrect commission',
  'orders': 'Order issue',
  'refunds': 'Cancellation or refund',
  'products': 'Product or inventory',
  'technical': 'Technical issue',
  'other': 'Other',
};

class Ticket {
  const Ticket({
    required this.id,
    required this.number,
    required this.category,
    required this.subject,
    required this.status,
    this.orderId,
    this.createdAt,
    this.updatedAt,
  });

  factory Ticket.fromJson(Map<String, dynamic> j) => Ticket(
    id: '${j['id']}',
    number: _n(j['number']),
    category: '${j['category']}',
    subject: '${j['subject']}',
    status: '${j['status']}',
    orderId: j['orderId'] as String?,
    createdAt: _d(j['createdAt']),
    updatedAt: _d(j['updatedAt']),
  );

  final String id;
  final int number;
  final String category;
  final String subject;

  /// open, in_progress, waiting_on_requester, resolved, closed.
  final String status;
  final String? orderId;
  final DateTime? createdAt;
  final DateTime? updatedAt;
}

class TicketMessage {
  const TicketMessage({
    required this.id,
    required this.body,
    required this.fromYou,
    this.attachments = const [],
    this.createdAt,
  });
  factory TicketMessage.fromJson(Map<String, dynamic> j) => TicketMessage(
    id: '${j['id']}',
    body: '${j['body']}',
    fromYou: j['fromYou'] == true,
    attachments: [
      for (final a in _list(j['attachments']))
        if (a['url'] != null) '${a['url']}',
    ],
    createdAt: _d(j['createdAt']),
  );
  final String id;
  final String body;
  final bool fromYou;

  /// Signed image URLs (valid for a few minutes).
  final List<String> attachments;
  final DateTime? createdAt;
}

class TicketThread {
  const TicketThread({required this.ticket, required this.messages});
  factory TicketThread.fromJson(Map<String, dynamic> j) => TicketThread(
    ticket: Ticket.fromJson(_map(j['ticket'])),
    messages: _list(j['messages']).map(TicketMessage.fromJson).toList(),
  );
  final Ticket ticket;
  final List<TicketMessage> messages;
}

// ---- Inbox ----

class InboxItem {
  const InboxItem({
    required this.id,
    required this.category,
    required this.title,
    required this.body,
    this.data = const {},
    this.read = false,
    this.createdAt,
  });
  factory InboxItem.fromJson(Map<String, dynamic> j) => InboxItem(
    id: '${j['id']}',
    category: '${j['category']}',
    title: '${j['title']}',
    body: '${j['body']}',
    data: _map(j['data']),
    read: j['read'] == true,
    createdAt: _d(j['createdAt']),
  );
  final String id;
  final String category;
  final String title;
  final String body;
  final Map<String, dynamic> data;
  final bool read;
  final DateTime? createdAt;

  /// Where tapping it goes in the app, if anywhere.
  String? get url => data['url'] as String?;

  InboxItem asRead() =>
      InboxItem(id: id, category: category, title: title, body: body, data: data, read: true, createdAt: createdAt);
}

class Announcement {
  const Announcement({required this.id, required this.title, required this.body, this.startsAt});
  factory Announcement.fromJson(Map<String, dynamic> j) =>
      Announcement(id: '${j['id']}', title: '${j['title']}', body: '${j['body']}', startsAt: _d(j['startsAt']));
  final String id;
  final String title;
  final String body;
  final DateTime? startsAt;
}

class Inbox {
  const Inbox({
    required this.available,
    required this.items,
    required this.unread,
    required this.announcements,
    required this.hasMore,
  });
  factory Inbox.fromJson(Map<String, dynamic> j) => Inbox(
    available: j['available'] != false,
    items: _list(j['items']).map(InboxItem.fromJson).toList(),
    unread: _n(j['unread']),
    announcements: _list(j['announcements']).map(Announcement.fromJson).toList(),
    hasMore: j['hasMore'] == true,
  );
  final bool available;
  final List<InboxItem> items;
  final int unread;
  final List<Announcement> announcements;
  final bool hasMore;
}
