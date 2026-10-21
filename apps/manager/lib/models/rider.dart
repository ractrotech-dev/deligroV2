import 'package:uuid/uuid.dart';

import 'cash.dart';
import 'delivery_exception.dart';
import 'json_util.dart';
import 'payment_request.dart';
import 'tickets.dart';
import 'vendors.dart' show PersonRef, ZoneRef;

/// Riders as `/api/manager/riders*` send them (Phase 5 plan, "API
/// contract"). Enums parse leniently: an unknown value becomes `unknown`.

enum RiderState {
  online('online', 'Online'),
  available('available', 'Available'),
  onDelivery('on_delivery', 'On delivery'),
  onBreak('break', 'On a break'),
  stale('stale', 'Location stale'),
  offline('offline', 'Offline'),
  unknown('unknown', 'Unknown');

  const RiderState(this.wire, this.label);
  final String wire;
  final String label;

  static RiderState parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);
}

enum RiderVerification {
  unverified('Not verified'),
  pending('Waiting for review'),
  verified('Verified'),
  rejected('Rejected'),
  unknown('Unknown');

  const RiderVerification(this.label);
  final String label;

  static RiderVerification parse(Object? s) => jEnum(values, s, unknown);
}

enum RiderAccount {
  active('Active'),
  suspended('Suspended'),
  restricted('Restricted'),
  unknown('Unknown');

  const RiderAccount(this.label);
  final String label;

  static RiderAccount parse(Object? s) => jEnum(values, s, unknown);
}

enum RiderDocType {
  aadhaar('aadhaar', 'Aadhaar'),
  pan('pan', 'PAN card'),
  drivingLicence('driving_licence', 'Driving licence'),
  vehicleRc('vehicle_rc', 'Vehicle RC'),
  insurance('insurance', 'Insurance'),
  puc('puc', 'PUC certificate'),
  photo('photo', 'Photo'),
  unknown('unknown', 'Document');

  const RiderDocType(this.wire, this.label);
  final String wire;
  final String label;

  static RiderDocType parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);

  /// Needed (verified) before a rider can be approved without an override.
  static const required = [aadhaar, drivingLicence, photo];

  /// Only asked for when the rider brings their own vehicle.
  static const ownVehicle = [vehicleRc, insurance, puc];

  /// The server refuses these without an expiry date.
  bool get needsExpiry => this == drivingLicence || this == insurance || this == puc;
}

enum RiderDocStatus {
  pending('Waiting for review'),
  verified('Verified'),
  rejected('Rejected'),
  expired('Expired'),
  replaced('Replaced'),
  unknown('Unknown');

  const RiderDocStatus(this.label);
  final String label;

  static RiderDocStatus parse(Object? s) => jEnum(values, s, unknown);
}

enum VehicleType {
  evBike('ev_bike', 'EV bike'),
  bike('bike', 'Motorbike'),
  scooter('scooter', 'Scooter'),
  bicycle('bicycle', 'Bicycle'),
  other('other', 'Other'),
  unknown('unknown', 'Not set');

  const VehicleType(this.wire, this.label);
  final String wire;
  final String label;

  static VehicleType parse(Object? s) => jEnum(values, s, unknown, (v) => v.wire);

  static const choices = [evBike, bike, scooter, bicycle, other];
}

class RiderListItem {
  const RiderListItem({
    required this.id,
    required this.state,
    required this.verification,
    required this.account,
    this.riderCode,
    this.name,
    this.phone,
    this.photoUrl,
    this.lastFixAt,
    this.fixAgeSeconds,
    this.zones = const [],
    this.activeDeliveries = 0,
    this.deliveredToday = 0,
    this.rating,
    this.ratingCount = 0,
    this.pendingDocuments = 0,
    this.expiringDocuments = 0,
    this.openComplaints = 0,
  });

  factory RiderListItem.fromJson(Map<String, dynamic> j) => RiderListItem(
        id: jStrOr(j['id']),
        riderCode: jStr(j['riderCode']),
        name: jStr(j['name']),
        phone: jStr(j['phone']),
        photoUrl: jStr(j['photoUrl']),
        state: RiderState.parse(j['state']),
        lastFixAt: jDate(j['lastFixAt']),
        fixAgeSeconds: jIntOrNull(j['fixAgeSeconds']),
        zones: [
          for (final z in jMaps(j['zones'])) ZoneRef(id: jStrOr(z['id']), name: jStrOr(z['name'])),
        ],
        verification: RiderVerification.parse(j['verification']),
        account: RiderAccount.parse(j['account']),
        activeDeliveries: jInt(j['activeDeliveries']),
        deliveredToday: jInt(j['deliveredToday']),
        rating: jDoubleOrNull(j['rating']),
        ratingCount: jInt(j['ratingCount']),
        pendingDocuments: jInt(j['pendingDocuments']),
        expiringDocuments: jInt(j['expiringDocuments']),
        // A count on list rows; the detail sends the open tickets themselves.
        openComplaints: j['openComplaints'] is List ? (j['openComplaints'] as List).length : jInt(j['openComplaints']),
      );

  final String id;
  final String? riderCode;
  final String? name;
  final String? phone;
  final String? photoUrl;
  final RiderState state;
  final DateTime? lastFixAt;
  final int? fixAgeSeconds;
  final List<ZoneRef> zones;
  final RiderVerification verification;
  final RiderAccount account;
  final int activeDeliveries;
  final int deliveredToday;
  final double? rating;
  final int ratingCount;
  final int pendingDocuments;
  final int expiringDocuments;
  final int openComplaints;

  String get displayName => name?.trim().isNotEmpty ?? false ? name!.trim() : 'Unnamed rider';
}

class RiderCounts {
  const RiderCounts({
    this.all = 0,
    this.online = 0,
    this.available = 0,
    this.onDelivery = 0,
    this.onBreak = 0,
    this.stale = 0,
    this.offline = 0,
    this.suspended = 0,
    this.needsReview = 0,
  });

  factory RiderCounts.fromJson(Map<String, dynamic>? j) => RiderCounts(
        all: jInt(j?['all']),
        online: jInt(j?['online']),
        available: jInt(j?['available']),
        onDelivery: jInt(j?['on_delivery']),
        onBreak: jInt(j?['break']),
        stale: jInt(j?['stale']),
        offline: jInt(j?['offline']),
        suspended: jInt(j?['suspended']),
        needsReview: jInt(j?['needs_review']),
      );

  final int all;
  final int online;
  final int available;
  final int onDelivery;
  final int onBreak;
  final int stale;
  final int offline;
  final int suspended;
  final int needsReview;

  int of(RiderState s) => switch (s) {
        RiderState.online => online,
        RiderState.available => available,
        RiderState.onDelivery => onDelivery,
        RiderState.onBreak => onBreak,
        RiderState.stale => stale,
        RiderState.offline => offline,
        RiderState.unknown => 0,
      };
}

class RiderPage {
  const RiderPage({required this.items, this.nextCursor, this.counts = const RiderCounts()});
  factory RiderPage.fromJson(Map<String, dynamic> j) => RiderPage(
        items: [for (final r in jMaps(j['items'])) RiderListItem.fromJson(r)],
        nextCursor: jStr(j['nextCursor']),
        counts: RiderCounts.fromJson(jMap(j['counts'])),
      );
  final List<RiderListItem> items;
  final String? nextCursor;
  final RiderCounts counts;
}

class RiderDocument {
  const RiderDocument({
    required this.id,
    required this.type,
    required this.status,
    this.numberMasked,
    this.expiresOn,
    this.remarks,
    this.reviewedBy,
    this.reviewedAt,
    this.uploadedAt,
  });

  factory RiderDocument.fromJson(Map<String, dynamic> j) => RiderDocument(
        id: jStrOr(j['id']),
        type: RiderDocType.parse(j['type']),
        numberMasked: jStr(j['numberMasked']),
        expiresOn: jStr(j['expiresOn']),
        status: RiderDocStatus.parse(j['status']),
        remarks: jStr(j['remarks']),
        reviewedBy: PersonRef.fromJson(j['reviewedBy']),
        reviewedAt: jDate(j['reviewedAt']),
        uploadedAt: jDate(j['uploadedAt']),
      );

  final String id;
  final RiderDocType type;
  final String? numberMasked;

  /// `YYYY-MM-DD` (IST), or null for documents that do not expire.
  final String? expiresOn;
  final RiderDocStatus status;
  final String? remarks;
  final PersonRef? reviewedBy;
  final DateTime? reviewedAt;
  final DateTime? uploadedAt;

  DateTime? get expiryDate => expiresOn == null ? null : DateTime.tryParse(expiresOn!);
}

class EmergencyContact {
  const EmergencyContact({this.name, this.phone, this.relation});
  factory EmergencyContact.fromJson(Map<String, dynamic>? j) =>
      EmergencyContact(name: jStr(j?['name']), phone: jStr(j?['phone']), relation: jStr(j?['relation']));
  final String? name;
  final String? phone;
  final String? relation;
}

class RiderProfile {
  const RiderProfile({
    this.vehicleType = VehicleType.unknown,
    this.vehicleOwner,
    this.vehicleRegistration,
    this.licenceNumberMasked,
    this.licenceExpiresOn,
    this.address,
    this.pincode,
    this.emergency = const EmergencyContact(),
    this.joinedAt,
  });

  factory RiderProfile.fromJson(Map<String, dynamic>? j) => RiderProfile(
        vehicleType: VehicleType.parse(j?['vehicleType']),
        vehicleOwner: jStr(j?['vehicleOwner']),
        vehicleRegistration: jStr(j?['vehicleRegistration']),
        licenceNumberMasked: jStr(j?['licenceNumberMasked']),
        licenceExpiresOn: jStr(j?['licenceExpiresOn']),
        address: jStr(j?['address']),
        pincode: jStr(j?['pincode']),
        emergency: EmergencyContact.fromJson(jMap(j?['emergency'])),
        joinedAt: jDate(j?['joinedAt']),
      );

  final VehicleType vehicleType;

  /// `deligro` or `rider`.
  final String? vehicleOwner;
  final String? vehicleRegistration;
  final String? licenceNumberMasked;
  final String? licenceExpiresOn;
  final String? address;
  final String? pincode;
  final EmergencyContact emergency;
  final DateTime? joinedAt;
}

class RiderPosition {
  const RiderPosition({required this.lat, required this.lng, this.at});
  static RiderPosition? fromJson(Object? v) {
    final j = jMap(v);
    if (j == null || j['lat'] is! num || j['lng'] is! num) return null;
    return RiderPosition(lat: jDouble(j['lat']), lng: jDouble(j['lng']), at: jDate(j['at']));
  }

  final double lat;
  final double lng;
  final DateTime? at;
}

class RiderAvailability {
  const RiderAvailability({this.onlineSince, this.breakUntil, this.position});
  factory RiderAvailability.fromJson(Map<String, dynamic>? j) => RiderAvailability(
        onlineSince: jDate(j?['onlineSince']),
        breakUntil: jDate(j?['breakUntil']),
        position: RiderPosition.fromJson(j?['position']),
      );
  final DateTime? onlineSince;
  final DateTime? breakUntil;

  /// Only while the rider is online or holds a delivery (§5.7).
  final RiderPosition? position;
}

class Place {
  const Place({this.name, this.area, this.lat, this.lng});
  factory Place.fromJson(Map<String, dynamic>? j) => Place(
        name: jStr(j?['name']),
        area: jStr(j?['area']),
        lat: jDoubleOrNull(j?['lat']),
        lng: jDoubleOrNull(j?['lng']),
      );
  final String? name;
  final String? area;
  final double? lat;
  final double? lng;

  bool get hasPoint => lat != null && lng != null && !(lat == 0 && lng == 0);
}

class ActiveDelay {
  const ActiveDelay({required this.kind, required this.minutes});
  static ActiveDelay? fromJson(Object? v) {
    final j = jMap(v);
    return j == null ? null : ActiveDelay(kind: jStrOr(j['kind']), minutes: jInt(j['minutes']));
  }

  /// `prep|pickup|delivery|unassigned`.
  final String kind;
  final int minutes;
}

class ActiveDelivery {
  const ActiveDelivery({
    required this.orderId,
    required this.code,
    required this.status,
    this.shop = const Place(),
    this.drop = const Place(),
    this.etaPickupAt,
    this.etaDeliveryAt,
    this.route = const [],
    this.delay,
  });

  factory ActiveDelivery.fromJson(Map<String, dynamic> j) => ActiveDelivery(
        orderId: jStrOr(j['orderId']),
        code: jStrOr(j['code']),
        status: jStrOr(j['status']),
        shop: Place.fromJson(jMap(j['shop'])),
        drop: Place.fromJson(jMap(j['drop'])),
        etaPickupAt: jDate(j['etaPickupAt']),
        etaDeliveryAt: jDate(j['etaDeliveryAt']),
        route: [
          for (final p in (j['route'] is List ? j['route'] as List : const []))
            if (p is List && p.length >= 2 && p[0] is num && p[1] is num) ((p[0] as num).toDouble(), (p[1] as num).toDouble()),
        ],
        delay: ActiveDelay.fromJson(j['delay']),
      );

  final String orderId;
  final String code;

  /// `assigned` or `picked_up`.
  final String status;
  final Place shop;
  final Place drop;
  final DateTime? etaPickupAt;
  final DateTime? etaDeliveryAt;
  final List<(double, double)> route;
  final ActiveDelay? delay;

  bool get pickedUp => status == 'picked_up';
}

class PerformanceMonth {
  const PerformanceMonth({
    required this.month,
    this.delivered = 0,
    this.failed = 0,
    this.cancelled = 0,
    this.acceptanceRate,
    this.avgDeliverMin,
    this.onlineHours,
  });
  factory PerformanceMonth.fromJson(Map<String, dynamic> j) => PerformanceMonth(
        month: jStrOr(j['month']),
        delivered: jInt(j['delivered']),
        failed: jInt(j['failed']),
        cancelled: jInt(j['cancelled']),
        acceptanceRate: jDoubleOrNull(j['acceptanceRate']),
        avgDeliverMin: jDoubleOrNull(j['avgDeliverMin']),
        onlineHours: jDoubleOrNull(j['onlineHours']),
      );
  final String month;
  final int delivered;
  final int failed;
  final int cancelled;
  final double? acceptanceRate;
  final double? avgDeliverMin;
  final double? onlineHours;
}

class RiderPerformance {
  const RiderPerformance({
    this.from,
    this.to,
    this.delivered = 0,
    this.failed = 0,
    this.cancelled = 0,
    this.acceptanceRate,
    this.avgDeliverMinutes,
    this.avgPickupToDeliverMinutes,
    this.failedRate,
    this.onlineHours,
    this.months = const [],
  });

  factory RiderPerformance.fromJson(Map<String, dynamic>? j) => RiderPerformance(
        from: jStr(j?['from']),
        to: jStr(j?['to']),
        delivered: jInt(j?['delivered']),
        failed: jInt(j?['failed']),
        cancelled: jInt(j?['cancelled']),
        acceptanceRate: jDoubleOrNull(j?['acceptanceRate']),
        avgDeliverMinutes: jDoubleOrNull(j?['avgDeliverMinutes']),
        avgPickupToDeliverMinutes: jDoubleOrNull(j?['avgPickupToDeliverMinutes']),
        failedRate: jDoubleOrNull(j?['failedRate']),
        onlineHours: jDoubleOrNull(j?['onlineHours']),
        months: [for (final m in jMaps(j?['months'])) PerformanceMonth.fromJson(m)],
      );

  final String? from;
  final String? to;
  final int delivered;
  final int failed;
  final int cancelled;
  final double? acceptanceRate;
  final double? avgDeliverMinutes;
  final double? avgPickupToDeliverMinutes;
  final double? failedRate;
  final double? onlineHours;
  final List<PerformanceMonth> months;
}

class RiderRating {
  const RiderRating({required this.rating, this.comment, this.at, this.orderCode});
  factory RiderRating.fromJson(Map<String, dynamic> j) => RiderRating(
        rating: jInt(j['rating']),
        comment: jStr(j['comment']),
        at: jDate(j['at']),
        orderCode: jStr(j['orderCode']),
      );
  final int rating;
  final String? comment;
  final DateTime? at;
  final String? orderCode;
}

class RiderRatings {
  const RiderRatings({this.average, this.count = 0, this.distribution = const {}, this.recent = const []});
  factory RiderRatings.fromJson(Map<String, dynamic>? j) {
    final d = jMap(j?['distribution']) ?? const {};
    return RiderRatings(
      average: jDoubleOrNull(j?['average']),
      count: jInt(j?['count']),
      distribution: {for (var s = 1; s <= 5; s++) s: jInt(d['$s'])},
      recent: [for (final r in jMaps(j?['recent'])) RiderRating.fromJson(r)],
    );
  }
  final double? average;
  final int count;
  final Map<int, int> distribution;
  final List<RiderRating> recent;
}

class Payout {
  const Payout({
    required this.id,
    required this.amount,
    required this.method,
    this.reference,
    this.paidOn,
    this.periodEnd,
    this.items = 0,
    this.requestId,
  });
  factory Payout.fromJson(Map<String, dynamic> j) => Payout(
        id: jStrOr(j['id']),
        amount: jDouble(j['amount']),
        method: PayMethod.parse(j['method']),
        reference: jStr(j['reference']),
        paidOn: jStr(j['paidOn']),
        periodEnd: jStr(j['periodEnd']),
        items: jInt(j['items']),
        requestId: jStr(j['requestId']),
      );
  final String id;
  final double amount;
  final PayMethod method;
  final String? reference;
  final String? paidOn;
  final String? periodEnd;
  final int items;
  final String? requestId;
}

class RiderMoney {
  const RiderMoney({this.pending = 0, this.paidTotal = 0, this.lastPayout, this.pendingRequests = const []});
  factory RiderMoney.fromJson(Map<String, dynamic> j) {
    final last = jMap(j['lastPayout']);
    return RiderMoney(
      pending: jDouble(j['pending']),
      paidTotal: jDouble(j['paidTotal']),
      lastPayout: last == null ? null : Payout.fromJson(last),
      pendingRequests: [for (final r in jMaps(j['pendingRequests'])) PaymentRequest.fromJson(r)],
    );
  }
  final double pending;
  final double paidTotal;
  final Payout? lastPayout;
  final List<PaymentRequest> pendingRequests;
}

class RiderCash {
  const RiderCash({
    this.collectedToday = 0,
    this.depositedToday = 0,
    this.pendingDeposit = 0,
    this.openDeposits = const [],
    this.openDisputes = const [],
  });
  factory RiderCash.fromJson(Map<String, dynamic>? j) => RiderCash(
        collectedToday: jInt(j?['collectedToday']),
        depositedToday: jInt(j?['depositedToday']),
        pendingDeposit: jInt(j?['pendingDeposit']),
        openDeposits: [for (final d in jMaps(j?['openDeposits'])) CashDeposit.fromJson(d)],
        openDisputes: [for (final d in jMaps(j?['openDisputes'])) CashDispute.fromJson(d)],
      );
  final int collectedToday;
  final int depositedToday;
  final int pendingDeposit;
  final List<CashDeposit> openDeposits;
  final List<CashDispute> openDisputes;
}

class RiderAllowed {
  const RiderAllowed({
    this.approve = false,
    this.reject = false,
    this.suspend = false,
    this.reactivate = false,
    this.forceOffline = false,
    this.reviewDocuments = false,
    this.uploadDocuments = false,
    this.addAdjustment = false,
    this.requestPayout = false,
    this.assign = false,
  });

  factory RiderAllowed.fromJson(Map<String, dynamic>? j) => RiderAllowed(
        approve: jBool(j?['approve']),
        reject: jBool(j?['reject']),
        suspend: jBool(j?['suspend']),
        reactivate: jBool(j?['reactivate']),
        forceOffline: jBool(j?['forceOffline']),
        reviewDocuments: jBool(j?['reviewDocuments']),
        uploadDocuments: jBool(j?['uploadDocuments']),
        addAdjustment: jBool(j?['addAdjustment']),
        requestPayout: jBool(j?['requestPayout']),
        assign: jBool(j?['assign']),
      );

  final bool approve;
  final bool reject;
  final bool suspend;
  final bool reactivate;
  final bool forceOffline;
  final bool reviewDocuments;
  final bool uploadDocuments;
  final bool addAdjustment;
  final bool requestPayout;
  final bool assign;
}

class RiderDetail {
  const RiderDetail({
    required this.summary,
    this.accountReason,
    this.accountChangedAt,
    this.accountChangedBy,
    this.verifiedAt,
    this.verifiedBy,
    this.profile = const RiderProfile(),
    this.availability = const RiderAvailability(),
    this.active = const [],
    this.performance = const RiderPerformance(),
    this.ratings = const RiderRatings(),
    this.documents = const [],
    this.money,
    this.cash = const RiderCash(),
    this.openExceptions = const [],
    this.openComplaints = const [],
    this.allowed = const RiderAllowed(),
  });

  factory RiderDetail.fromJson(Map<String, dynamic> j) {
    final money = jMap(j['money']);
    return RiderDetail(
      summary: RiderListItem.fromJson(j),
      accountReason: jStr(j['accountReason']),
      accountChangedAt: jDate(j['accountChangedAt']),
      accountChangedBy: PersonRef.fromJson(j['accountChangedBy']),
      verifiedAt: jDate(j['verifiedAt']),
      verifiedBy: PersonRef.fromJson(j['verifiedBy']),
      profile: RiderProfile.fromJson(jMap(j['profile'])),
      availability: RiderAvailability.fromJson(jMap(j['availability'])),
      active: [for (final a in jMaps(j['active'])) ActiveDelivery.fromJson(a)],
      performance: RiderPerformance.fromJson(jMap(j['performance'])),
      ratings: RiderRatings.fromJson(jMap(j['ratings'])),
      documents: [for (final d in jMaps(j['documents'])) RiderDocument.fromJson(d)],
      money: money == null ? null : RiderMoney.fromJson(money),
      cash: RiderCash.fromJson(jMap(j['cash'])),
      openExceptions: [for (final e in jMaps(j['openExceptions'])) DeliveryException.fromJson(e)],
      openComplaints: [for (final t in jMaps(j['openComplaints'])) TicketSummary.fromJson(t)],
      allowed: RiderAllowed.fromJson(jMap(j['allowed'])),
    );
  }

  final RiderListItem summary;
  final String? accountReason;
  final DateTime? accountChangedAt;
  final PersonRef? accountChangedBy;
  final DateTime? verifiedAt;
  final PersonRef? verifiedBy;
  final RiderProfile profile;
  final RiderAvailability availability;
  final List<ActiveDelivery> active;
  final RiderPerformance performance;
  final RiderRatings ratings;
  final List<RiderDocument> documents;

  /// Absent without `manager.finance.view`.
  final RiderMoney? money;
  final RiderCash cash;
  final List<DeliveryException> openExceptions;
  final List<TicketSummary> openComplaints;
  final RiderAllowed allowed;

  String get id => summary.id;
  String get name => summary.displayName;
}

// ---------------------------------------------------------------- history

enum RiderOutcome {
  delivered('Delivered'),
  failed('Failed'),
  cancelled('Cancelled'),
  reassigned('Reassigned'),
  unknown('Unknown');

  const RiderOutcome(this.label);
  final String label;

  static RiderOutcome parse(Object? s) => jEnum(values, s, unknown);

  static const filters = [delivered, failed, cancelled, reassigned];
}

class RiderHistoryItem {
  const RiderHistoryItem({
    required this.orderId,
    required this.code,
    required this.outcome,
    this.shop,
    this.dropArea,
    this.acceptedAt,
    this.pickedUpAt,
    this.deliveredAt,
    this.endedAt,
    this.distanceKm,
    this.reason,
    this.cancelledBy,
    this.proof,
    this.itemCount = 0,
    this.orderValue = 0,
  });

  factory RiderHistoryItem.fromJson(Map<String, dynamic> j) => RiderHistoryItem(
        orderId: jStrOr(j['orderId']),
        code: jStrOr(j['code']),
        shop: jStr(j['shop']),
        dropArea: jStr(j['dropArea']),
        outcome: RiderOutcome.parse(j['outcome']),
        acceptedAt: jDate(j['acceptedAt']),
        pickedUpAt: jDate(j['pickedUpAt']),
        deliveredAt: jDate(j['deliveredAt']),
        endedAt: jDate(j['endedAt']),
        distanceKm: jDoubleOrNull(j['distanceKm']),
        reason: jStr(j['reason']),
        cancelledBy: jStr(j['cancelledBy']),
        proof: jStr(j['proof']),
        itemCount: jInt(j['itemCount']),
        orderValue: jInt(j['orderValue']),
      );

  final String orderId;
  final String code;
  final String? shop;
  final String? dropArea;
  final RiderOutcome outcome;
  final DateTime? acceptedAt;
  final DateTime? pickedUpAt;
  final DateTime? deliveredAt;
  final DateTime? endedAt;
  final double? distanceKm;
  final String? reason;
  final String? cancelledBy;
  final String? proof;
  final int itemCount;
  final int orderValue;
}

class HistoryTotals {
  const HistoryTotals({this.delivered = 0, this.failed = 0, this.cancelled = 0, this.reassigned = 0});
  factory HistoryTotals.fromJson(Map<String, dynamic>? j) => HistoryTotals(
        delivered: jInt(j?['delivered']),
        failed: jInt(j?['failed']),
        cancelled: jInt(j?['cancelled']),
        reassigned: jInt(j?['reassigned']),
      );
  final int delivered;
  final int failed;
  final int cancelled;
  final int reassigned;

  int of(RiderOutcome o) => switch (o) {
        RiderOutcome.delivered => delivered,
        RiderOutcome.failed => failed,
        RiderOutcome.cancelled => cancelled,
        RiderOutcome.reassigned => reassigned,
        RiderOutcome.unknown => 0,
      };
}

class RiderHistoryPage {
  const RiderHistoryPage({required this.items, this.nextCursor, this.totals = const HistoryTotals()});
  factory RiderHistoryPage.fromJson(Map<String, dynamic> j) => RiderHistoryPage(
        items: [for (final h in jMaps(j['items'])) RiderHistoryItem.fromJson(h)],
        nextCursor: jStr(j['nextCursor']),
        totals: HistoryTotals.fromJson(jMap(j['totals'])),
      );
  final List<RiderHistoryItem> items;
  final String? nextCursor;
  final HistoryTotals totals;
}

class RatingPage {
  const RatingPage({required this.items, this.nextCursor});
  factory RatingPage.fromJson(Map<String, dynamic> j) => RatingPage(
        items: [for (final r in jMaps(j['items'])) RiderRating.fromJson(r)],
        nextCursor: jStr(j['nextCursor']),
      );
  final List<RiderRating> items;
  final String? nextCursor;
}

// ---------------------------------------------------------------- ledger

enum LedgerType {
  earning('Earning'),
  incentive('Incentive'),
  salary('Salary'),
  bonus('Bonus'),
  deduction('Deduction'),
  adjustment('Adjustment'),
  unknown('Entry');

  const LedgerType(this.label);
  final String label;

  static LedgerType parse(Object? s) => jEnum(values, s, unknown);
}

enum LedgerStatus {
  pending('Pending'),
  paid('Paid'),
  unknown('Unknown');

  const LedgerStatus(this.label);
  final String label;

  static LedgerStatus parse(Object? s) => jEnum(values, s, unknown);
}

class LedgerRow {
  const LedgerRow({
    required this.id,
    required this.type,
    required this.amount,
    required this.status,
    this.date,
    this.reason,
    this.orderCode,
    this.payoutId,
    this.createdBy,
  });
  factory LedgerRow.fromJson(Map<String, dynamic> j) => LedgerRow(
        id: jStrOr(j['id']),
        type: LedgerType.parse(j['type']),
        amount: jDouble(j['amount']),
        date: jStr(j['date']),
        reason: jStr(j['reason']),
        orderCode: jStr(j['orderCode']),
        payoutId: jStr(j['payoutId']),
        status: LedgerStatus.parse(j['status']),
        createdBy: PersonRef.fromJson(j['createdBy']),
      );
  final String id;
  final LedgerType type;
  final double amount;
  final String? date;
  final String? reason;
  final String? orderCode;
  final String? payoutId;
  final LedgerStatus status;
  final PersonRef? createdBy;
}

class LedgerSummary {
  const LedgerSummary({this.pending = 0, this.paid = 0});
  factory LedgerSummary.fromJson(Map<String, dynamic>? j) =>
      LedgerSummary(pending: jDouble(j?['pending']), paid: jDouble(j?['paid']));
  final double pending;
  final double paid;
}

class LedgerPage {
  const LedgerPage({required this.items, this.nextCursor, this.payouts = const [], this.summary = const LedgerSummary()});
  factory LedgerPage.fromJson(Map<String, dynamic> j) => LedgerPage(
        items: [for (final r in jMaps(j['items'])) LedgerRow.fromJson(r)],
        nextCursor: jStr(j['nextCursor']),
        payouts: [for (final p in jMaps(j['payouts'])) Payout.fromJson(p)],
        summary: LedgerSummary.fromJson(jMap(j['summary'])),
      );
  final List<LedgerRow> items;
  final String? nextCursor;
  final List<Payout> payouts;
  final LedgerSummary summary;
}

// ---------------------------------------------------------------- filters

/// The list's quick filters (contract `filter=`).
enum RiderQuickFilter {
  needsReview('needs_review'),
  expiring('expiring');

  const RiderQuickFilter(this.wire);
  final String wire;

  static RiderQuickFilter? parse(String? s) {
    for (final v in values) {
      if (v.wire == s) return v;
    }
    return null;
  }
}

/// What the Riders list asks for. Immutable; a new value is a new list.
class RiderFilters {
  const RiderFilters({this.q, this.states = const {}, this.verification, this.account, this.zoneId, this.filter});

  /// Reads `/more/riders?…` — the dashboard's tiles open it filtered
  /// (`?account=active`, `?state=online,available,on_delivery`).
  factory RiderFilters.fromUri(Uri uri) {
    final p = uri.queryParameters;
    String? s(String k) => (p[k]?.trim().isEmpty ?? true) ? null : p[k]!.trim();
    final v = RiderVerification.parse(s('verification'));
    final a = RiderAccount.parse(s('account'));
    return RiderFilters(
      q: s('q'),
      states: {
        for (final w in (p['state'] ?? '').split(','))
          if (RiderState.parse(w.trim()) != RiderState.unknown) RiderState.parse(w.trim()),
      },
      verification: v == RiderVerification.unknown ? null : v,
      account: a == RiderAccount.unknown ? null : a,
      zoneId: s('zone'),
      filter: RiderQuickFilter.parse(s('filter')),
    );
  }

  final String? q;
  final Set<RiderState> states;
  final RiderVerification? verification;
  final RiderAccount? account;
  final String? zoneId;
  final RiderQuickFilter? filter;

  /// The tabs' order, so the query string is stable.
  static const _stateOrder = RiderState.values;

  Map<String, String> toQuery() {
    final ordered = [for (final s in _stateOrder) if (states.contains(s)) s.wire];
    return {
      'q': ?q,
      if (ordered.isNotEmpty) 'state': ordered.join(','),
      if (verification != null) 'verification': verification!.name,
      if (account != null) 'account': account!.name,
      'zone': ?zoneId,
      if (filter != null) 'filter': filter!.wire,
    };
  }

  /// Anything beyond the zone narrows the list.
  bool get narrowed => q != null || states.isNotEmpty || verification != null || account != null || filter != null;

  RiderFilters copyWith({
    Object? q = _keep,
    Set<RiderState>? states,
    Object? verification = _keep,
    Object? account = _keep,
    Object? zoneId = _keep,
    Object? filter = _keep,
  }) =>
      RiderFilters(
        q: identical(q, _keep) ? this.q : q as String?,
        states: states ?? this.states,
        verification: identical(verification, _keep) ? this.verification : verification as RiderVerification?,
        account: identical(account, _keep) ? this.account : account as RiderAccount?,
        zoneId: identical(zoneId, _keep) ? this.zoneId : zoneId as String?,
        filter: identical(filter, _keep) ? this.filter : filter as RiderQuickFilter?,
      );

  @override
  bool operator ==(Object other) =>
      other is RiderFilters &&
      other.q == q &&
      other.states.length == states.length &&
      other.states.containsAll(states) &&
      other.verification == verification &&
      other.account == account &&
      other.zoneId == zoneId &&
      other.filter == filter;

  @override
  int get hashCode => Object.hash(q, Object.hashAllUnordered(states), verification, account, zoneId, filter);
}

const _keep = Object();

// ---------------------------------------------------------------- actions

const _uuid = Uuid();

String ymd(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// One audited decision on a rider (`POST /api/manager/riders/[id]/actions`).
/// The id is made once, so Retry — and "Approve anyway" — is the same
/// action to the server.
sealed class RiderAction {
  RiderAction({String? clientActionId}) : clientActionId = clientActionId ?? _uuid.v4();
  final String clientActionId;

  String get wire;
  Map<String, dynamic> get extra;

  Map<String, dynamic> toJson() => {'action': wire, 'clientActionId': clientActionId, ...extra};
}

class ApproveRider extends RiderAction {
  ApproveRider({required this.expected, required this.reason, this.waiveDocuments = false, super.clientActionId});
  final RiderVerification expected;
  final String reason;

  /// Sent as `override`: approve although documents are unverified.
  final bool waiveDocuments;

  /// The same approval, accepting unverified documents (recorded as such).
  ApproveRider anyway() =>
      ApproveRider(expected: expected, reason: reason, waiveDocuments: true, clientActionId: clientActionId);

  @override
  String get wire => 'approve';
  @override
  Map<String, dynamic> get extra => {'expected': expected.name, 'reason': reason, 'override': waiveDocuments};
}

class RejectRider extends RiderAction {
  RejectRider({required this.expected, required this.reason, super.clientActionId});
  final RiderVerification expected;
  final String reason;
  @override
  String get wire => 'reject';
  @override
  Map<String, dynamic> get extra => {'expected': expected.name, 'reason': reason};
}

class SuspendRider extends RiderAction {
  SuspendRider({required this.expected, required this.reason, super.clientActionId});
  final RiderAccount expected;
  final String reason;
  @override
  String get wire => 'suspend';
  @override
  Map<String, dynamic> get extra => {'expected': expected.name, 'reason': reason};
}

class ReactivateRider extends RiderAction {
  ReactivateRider({required this.expected, required this.reason, super.clientActionId});
  final RiderAccount expected;
  final String reason;
  @override
  String get wire => 'reactivate';
  @override
  Map<String, dynamic> get extra => {'expected': expected.name, 'reason': reason};
}

class ForceOfflineRider extends RiderAction {
  ForceOfflineRider({required this.reason, super.clientActionId});
  final String reason;
  @override
  String get wire => 'force_offline';
  @override
  Map<String, dynamic> get extra => {'reason': reason};
}

class VerifyRiderDocument extends RiderAction {
  VerifyRiderDocument({required this.documentId, this.remarks, super.clientActionId});
  final String documentId;
  final String? remarks;
  @override
  String get wire => 'verify_document';
  @override
  Map<String, dynamic> get extra => {
        'documentId': documentId,
        if (remarks != null && remarks!.trim().isNotEmpty) 'remarks': remarks!.trim(),
      };
}

class RejectRiderDocument extends RiderAction {
  RejectRiderDocument({required this.documentId, required this.remarks, super.clientActionId});
  final String documentId;
  final String remarks;
  @override
  String get wire => 'reject_document';
  @override
  Map<String, dynamic> get extra => {'documentId': documentId, 'remarks': remarks};
}

enum AdjustmentKind {
  bonus('Bonus'),
  deduction('Deduction'),
  adjustment('Adjustment');

  const AdjustmentKind(this.label);
  final String label;
}

class AddRiderAdjustment extends RiderAction {
  AddRiderAdjustment({
    required this.kind,
    required this.amount,
    required this.effectiveOn,
    required this.reason,
    this.orderId,
    super.clientActionId,
  });
  final AdjustmentKind kind;
  final double amount;
  final DateTime effectiveOn;
  final String reason;
  final String? orderId;
  @override
  String get wire => 'add_adjustment';
  @override
  Map<String, dynamic> get extra => {
        'reason': reason,
        'adjustment': {'kind': kind.name, 'amount': amount, 'effectiveOn': ymd(effectiveOn), 'orderId': orderId},
      };
}

// ---------------------------------------------------------------- onboarding

/// What the onboarding form collects. Saved on the phone between steps —
/// never with the password.
class RiderOnboardDraft {
  const RiderOnboardDraft({
    this.fullName = '',
    this.mobile = '',
    this.email = '',
    this.password = '',
    this.zoneId,
    this.vehicleType = VehicleType.evBike,
    this.vehicleOwner = 'deligro',
    this.vehicleRegistration = '',
    this.licenceNumber = '',
    this.licenceExpiresOn,
    this.addressLine = '',
    this.pincode = '',
    this.emergencyName = '',
    this.emergencyPhone = '',
    this.emergencyRelation = '',
  });

  factory RiderOnboardDraft.fromJson(Map<String, dynamic> j) => RiderOnboardDraft(
        fullName: jStrOr(j['fullName']),
        mobile: jStrOr(j['mobile']),
        email: jStrOr(j['email']),
        zoneId: jStr(j['zoneId']),
        vehicleType: VehicleType.parse(j['vehicleType']) == VehicleType.unknown
            ? VehicleType.evBike
            : VehicleType.parse(j['vehicleType']),
        vehicleOwner: jStrOr(j['vehicleOwner'], 'deligro'),
        vehicleRegistration: jStrOr(j['vehicleRegistration']),
        licenceNumber: jStrOr(j['licenceNumber']),
        licenceExpiresOn: jStr(j['licenceExpiresOn']) == null ? null : DateTime.tryParse(jStr(j['licenceExpiresOn'])!),
        addressLine: jStrOr(j['addressLine']),
        pincode: jStrOr(j['pincode']),
        emergencyName: jStrOr(j['emergencyName']),
        emergencyPhone: jStrOr(j['emergencyPhone']),
        emergencyRelation: jStrOr(j['emergencyRelation']),
      );

  final String fullName;
  final String mobile;
  final String email;
  final String password;
  final String? zoneId;
  final VehicleType vehicleType;
  final String vehicleOwner;
  final String vehicleRegistration;
  final String licenceNumber;
  final DateTime? licenceExpiresOn;
  final String addressLine;
  final String pincode;
  final String emergencyName;
  final String emergencyPhone;
  final String emergencyRelation;

  bool get ownVehicle => vehicleOwner == 'rider';

  RiderOnboardDraft copyWith({
    String? fullName,
    String? mobile,
    String? email,
    String? password,
    Object? zoneId = _keep,
    VehicleType? vehicleType,
    String? vehicleOwner,
    String? vehicleRegistration,
    String? licenceNumber,
    Object? licenceExpiresOn = _keep,
    String? addressLine,
    String? pincode,
    String? emergencyName,
    String? emergencyPhone,
    String? emergencyRelation,
  }) =>
      RiderOnboardDraft(
        fullName: fullName ?? this.fullName,
        mobile: mobile ?? this.mobile,
        email: email ?? this.email,
        password: password ?? this.password,
        zoneId: identical(zoneId, _keep) ? this.zoneId : zoneId as String?,
        vehicleType: vehicleType ?? this.vehicleType,
        vehicleOwner: vehicleOwner ?? this.vehicleOwner,
        vehicleRegistration: vehicleRegistration ?? this.vehicleRegistration,
        licenceNumber: licenceNumber ?? this.licenceNumber,
        licenceExpiresOn: identical(licenceExpiresOn, _keep) ? this.licenceExpiresOn : licenceExpiresOn as DateTime?,
        addressLine: addressLine ?? this.addressLine,
        pincode: pincode ?? this.pincode,
        emergencyName: emergencyName ?? this.emergencyName,
        emergencyPhone: emergencyPhone ?? this.emergencyPhone,
        emergencyRelation: emergencyRelation ?? this.emergencyRelation,
      );

  /// Saved to the phone: everything except the password.
  Map<String, dynamic> toSaved() => {
        'fullName': fullName,
        'mobile': mobile,
        'email': email,
        'zoneId': zoneId,
        'vehicleType': vehicleType.wire,
        'vehicleOwner': vehicleOwner,
        'vehicleRegistration': vehicleRegistration,
        'licenceNumber': licenceNumber,
        'licenceExpiresOn': licenceExpiresOn == null ? null : ymd(licenceExpiresOn!),
        'addressLine': addressLine,
        'pincode': pincode,
        'emergencyName': emergencyName,
        'emergencyPhone': emergencyPhone,
        'emergencyRelation': emergencyRelation,
      };

  String? _opt(String s) => s.trim().isEmpty ? null : s.trim();

  Map<String, dynamic> toRequest(String clientActionId) => {
        'clientActionId': clientActionId,
        'fullName': fullName.trim(),
        'mobile': mobile.trim(),
        'email': _opt(email),
        'password': _opt(password),
        'zoneId': zoneId,
        'vehicleType': vehicleType.wire,
        'vehicleOwner': vehicleOwner,
        'vehicleRegistration': _opt(vehicleRegistration),
        'licenceNumber': _opt(licenceNumber),
        'licenceExpiresOn': licenceExpiresOn == null ? null : ymd(licenceExpiresOn!),
        'addressLine': _opt(addressLine),
        'pincode': _opt(pincode),
        'emergencyName': _opt(emergencyName),
        'emergencyPhone': _opt(emergencyPhone),
        'emergencyRelation': _opt(emergencyRelation),
      };
}

class RiderOnboardResult {
  const RiderOnboardResult({required this.riderId, this.riderCode, this.mobile, this.password});
  factory RiderOnboardResult.fromJson(Map<String, dynamic> j) {
    final c = jMap(j['credentials']);
    return RiderOnboardResult(
      riderId: jStrOr(j['riderId']),
      riderCode: jStr(j['riderCode']),
      mobile: jStr(c?['mobile']),
      password: jStr(c?['password']),
    );
  }
  final String riderId;
  final String? riderCode;
  final String? mobile;

  /// Shown once, only when the server generated it.
  final String? password;
}
