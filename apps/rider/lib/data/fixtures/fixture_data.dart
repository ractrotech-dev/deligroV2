// JSON for the fixture backend, in the exact shape `GET /api/rider/board`
// sends. Debug builds only: nothing outside fixture_backend.dart refers to this
// file, and that is itself behind `fixturesEnabled`, so a release build tree-
// shakes all of it away (it is Dart, not a bundled asset, for that reason).

const _kitchenOrder = 'f1000000-0000-4000-8000-000000000001';
const _heldOrder = 'f1000000-0000-4000-8000-000000000002';
const _openOrder = 'f1000000-0000-4000-8000-000000000003';
const _upcomingOrder = 'f1000000-0000-4000-8000-000000000004';

/// The fixture code every code check accepts.
const fixtureCode = '1234';

class FixtureData {
  const FixtureData._();

  /// Every scenario [board] knows: `idle`, `offers`, `full`, `exceptions`, and
  /// one per delivery status.
  static const scenarios = <String>[
    'idle',
    'offers',
    'full',
    'exceptions',
    'accepted',
    'arrived_pickup',
    'picked_up',
    'on_the_way',
    'arrived_drop',
    'delivered',
    'failed',
    'cancelled',
  ];

  static const _statuses = [
    'accepted',
    'arrived_pickup',
    'picked_up',
    'on_the_way',
    'arrived_drop',
    'delivered',
    'failed',
    'cancelled',
  ];

  static Map<String, dynamic> board(String scenario, {DateTime? now}) {
    final t = (now ?? DateTime.now()).toUtc();
    return switch (scenario) {
      'idle' => {'offers': [], 'upcoming': [], 'active': null, 'offerWindowSeconds': 180},
      'offers' => {
          'offers': [heldOffer(t), openOffer(t)],
          'upcoming': [upcoming(t)],
          'active': null,
          'offerWindowSeconds': 180,
        },
      'full' => {
          'offers': [heldOffer(t), openOffer(t)],
          'upcoming': [upcoming(t)],
          'active': active('on_the_way', now: t),
          'offerWindowSeconds': 180,
        },
      'exceptions' => {
          'offers': [],
          'upcoming': [],
          'active': active('arrived_drop', now: t, withExceptions: true),
          'offerWindowSeconds': 180,
        },
      final status when _statuses.contains(status) => {
          'offers': [],
          'upcoming': [],
          'active': active(status, now: t),
          'offerWindowSeconds': 180,
        },
      _ => throw ArgumentError.value(scenario, 'scenario', 'unknown fixture scenario'),
    };
  }

  static String _iso(DateTime t) => t.toUtc().toIso8601String();

  static Map<String, dynamic> _stop(String name, String line, double lat, double lng, {String? phone}) => {
        'name': name,
        'line': line,
        'point': {'lat': lat, 'lng': lng},
        'phone': phone,
      };

  static Map<String, dynamic> _offer({
    required String orderId,
    required String code,
    required String shop,
    required String shopLine,
    required String dropLine,
    required int items,
    required double shopToDrop,
    required double riderToShop,
    required int eta,
    required DateTime? expires,
    required bool held,
    required Map<String, dynamic> payment,
    String? instructions,
  }) =>
      {
        'orderId': orderId,
        'code': code,
        'shop': _stop(shop, shopLine, 21.7189, 81.5301),
        'drop': _stop('Customer', dropLine, 21.7102, 81.5398),
        'instructions': instructions,
        'itemCount': items,
        'shopToDropKm': shopToDrop,
        'riderToShopKm': riderToShop,
        'etaMinutes': eta,
        'offerExpiresAt': expires == null ? null : _iso(expires),
        'reservedForYou': held,
        'payment': payment,
        'estimatedEarning': null,
      };

  /// An order held for this rider, with the countdown running.
  static Map<String, dynamic> heldOffer(DateTime now) => _offer(
        orderId: _heldOrder,
        code: 'DL-4821',
        shop: 'Sharma Sweets and Snacks',
        shopLine: 'Main Road, Bemetara',
        dropLine: 'Ward 7, near the water tank',
        items: 4,
        shopToDrop: 2.6,
        riderToShop: 0.8,
        eta: 16,
        expires: now.add(const Duration(seconds: 150)),
        held: true,
        payment: {'instruction': 'collect', 'collectAmount': 485},
        instructions: 'Ring the bell twice',
      );

  /// An order nobody is holding: any online rider may take it.
  static Map<String, dynamic> openOffer(DateTime now) => _offer(
        orderId: _openOrder,
        code: 'DL-4822',
        shop: 'Annapurna Kitchen',
        shopLine: 'Station Road, Bemetara',
        dropLine: 'Gandhi Chowk',
        items: 2,
        shopToDrop: 4.1,
        riderToShop: 1.9,
        eta: 24,
        expires: null,
        held: false,
        payment: {'instruction': 'prepaid', 'collectAmount': 0},
      );

  /// A pickup the kitchen is still cooking.
  static Map<String, dynamic> upcoming(DateTime now) => {
        'offer': _offer(
          orderId: _upcomingOrder,
          code: 'DL-4823',
          shop: 'Bake House',
          shopLine: 'Market Complex, Bemetara',
          dropLine: 'Civil Lines',
          items: 3,
          shopToDrop: 1.7,
          riderToShop: 1.2,
          eta: 14,
          expires: null,
          held: false,
          payment: {'instruction': 'unconfirmed', 'collectAmount': 0},
        ),
        'readyInMinutes': 7,
      };

  /// The offer as a freshly accepted delivery.
  static Map<String, dynamic> activeFromOffer(Map<String, dynamic> offer, {DateTime? now}) {
    final t = (now ?? DateTime.now()).toUtc();
    return {
      ...active('accepted', now: t),
      'orderId': offer['orderId'],
      'code': offer['code'],
      'shop': offer['shop'],
      'payment': offer['payment'],
      'instructions': offer['instructions'],
    };
  }

  /// The delivery in [status] (an API status such as `picked_up`).
  static Map<String, dynamic> active(String status, {DateTime? now, bool withExceptions = false}) {
    if (!_statuses.contains(status)) {
      throw ArgumentError.value(status, 'status', 'unknown delivery status');
    }
    final t = (now ?? DateTime.now()).toUtc();
    final reached = _statuses.indexOf(status);
    final cancelled = status == 'cancelled';
    final failed = status == 'failed';

    Map<String, dynamic> event(String kind, int minutesAgo, {String? method, String? reason}) => {
          'kind': kind,
          'method': method,
          'reason': reason,
          'at': _iso(t.subtract(Duration(minutes: minutesAgo))),
        };

    final timeline = <Map<String, dynamic>>[
      event('offered', 40),
      event('accepted', 38),
      if (reached >= 1 && !cancelled) event('arrived_pickup', 28),
      if (reached >= 2 && !cancelled) event('picked_up', 22, method: 'code'),
      if (reached >= 3 && !cancelled) event('departed', 21),
      if ((reached >= 4 && !cancelled) || failed) event('arrived_drop', 9),
      if (status == 'delivered') event('delivered', 2, method: 'code'),
      if (failed) event('failed', 1, reason: 'Customer did not answer'),
      if (cancelled) event('cancelled', 20, reason: 'Cancelled by the shop'),
    ];

    final atDrop = status == 'arrived_drop' || status == 'delivered' || failed;

    return {
      'orderId': _kitchenOrder,
      'deliveryId': 'f2000000-0000-4000-8000-000000000001',
      'code': 'DL-4810',
      'status': status,
      'shop': _stop('Sharma Sweets and Snacks', 'Main Road, Bemetara', 21.7189, 81.5301, phone: '+919800000001'),
      'drop': {
        ..._stop('Customer', 'Ward 7, near the water tank', 21.7102, 81.5398, phone: '+919800000002'),
        'customerName': 'Anita Verma',
      },
      'instructions': 'Leave with the guard if the gate is locked',
      'items': [
        {'name': 'Paneer butter masala', 'qty': 1},
        {'name': 'Butter naan', 'qty': 4},
        {'name': 'Gulab jamun (2 pc)', 'qty': 1},
      ],
      'payment': {'instruction': 'collect', 'collectAmount': 485},
      'pickupCodeRequired': true,
      'distanceKm': 2.6,
      'etaMinutes': reached >= 5 ? null : 12,
      'podPhotoRequired': true,
      'timeline': timeline,
      'exceptions': withExceptions ? exceptions(t) : <Map<String, dynamic>>[],
      'arrivedDropAt': atDrop ? _iso(t.subtract(const Duration(minutes: 9))) : null,
      'unreachableWaitMinutes': 10,
    };
  }

  /// One pending, one approved with a note, one rejected with a note.
  static List<Map<String, dynamic>> exceptions(DateTime now) => [
        {
          'id': 'f3000000-0000-4000-8000-000000000001',
          'kind': 'customer_unreachable',
          'status': 'pending',
          'reason': 'Called twice, no answer',
          'decisionNote': null,
          'createdAt': _iso(now.subtract(const Duration(minutes: 2))),
        },
        {
          'id': 'f3000000-0000-4000-8000-000000000002',
          'kind': 'manual_pickup',
          'status': 'approved',
          'reason': 'Shop could not read the code',
          'decisionNote': 'Checked with the shop',
          'createdAt': _iso(now.subtract(const Duration(minutes: 25))),
        },
        {
          'id': 'f3000000-0000-4000-8000-000000000003',
          'kind': 'complete_without_code',
          'status': 'rejected',
          'reason': 'Customer phone is off',
          'decisionNote': 'Wait at the drop and try again',
          'createdAt': _iso(now.subtract(const Duration(minutes: 8))),
        },
      ];
}
