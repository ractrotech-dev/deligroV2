import '../core/api.dart';

class Serviceability {
  const Serviceability(this.status, this.distanceKm, this.radiusKm, this.reason);

  /// in_range | out_of_range | unlimited | unverifiable
  final String status;
  final double? distanceKm;
  final double? radiusKm;

  /// address_unpinned | shop_outside_area
  final String? reason;

  /// `blocksOrder` in src/lib/geo/service-area.ts.
  bool get blocks => status != 'in_range' && status != 'unlimited';
}

class PaymentRules {
  const PaymentRules(this.acceptCod, this.acceptOnline, this.codMaxOrder);
  final bool acceptCod;

  /// Already ANDed with the platform switch and Razorpay keys on the server.
  final bool acceptOnline;

  /// Whole rupees; 0 = no ceiling. COD allowed when total ≤ limit.
  final int codMaxOrder;

  bool codAllowedFor(int total) => acceptCod && (codMaxOrder == 0 || total <= codMaxOrder);

  static const fallback = PaymentRules(true, false, 0);
}

class CheckoutRepository {
  CheckoutRepository(this._api);
  final ApiClient _api;

  Future<Serviceability> serviceability(String slug, double lat, double lng) async {
    final res = await _api.get(
      '/api/restaurants/$slug/serviceability',
      query: {'lat': '$lat', 'lng': '$lng'},
    );
    final a = (res['area'] as Map?) ?? const {};
    return Serviceability(
      '${a['status'] ?? 'unverifiable'}',
      (a['distanceKm'] as num?)?.toDouble(),
      (a['radiusKm'] as num?)?.toDouble(),
      a['reason'] as String?,
    );
  }

  Future<PaymentRules> paymentRules(String slug) async {
    try {
      final res = await _api.get('/api/restaurants/$slug/payment-options');
      final r = (res['rules'] as Map?) ?? const {};
      return PaymentRules(
        r['acceptCod'] != false,
        r['acceptOnline'] == true,
        (r['codMaxOrder'] as num?)?.round() ?? 0,
      );
    } catch (_) {
      return PaymentRules.fallback;
    }
  }

  /// Returns the discount in rupees. Throws ApiException(`<reason>`), with
  /// `body['minOrder']` on `min_order`.
  Future<({String code, int discount})> validateCoupon(
    String code,
    int subtotal,
    String slug, {
    List<({String menuItemId, int qty})>? items,
  }) async {
    final res = await _api.post('/api/coupons/validate', {
      'code': code,
      'subtotal': subtotal,
      'restaurantSlug': slug,
      if (items != null) 'items': [for (final i in items) {'menuItemId': i.menuItemId, 'qty': i.qty}],
    });
    return (code: '${res['code']}', discount: (res['discount'] as num).round());
  }

  Future<({String keyId, String providerOrderId, int amountPaise})> razorpayOrder(
    String orderId,
  ) async {
    final res = await _api.post('/api/payments/razorpay/order', {'orderId': orderId});
    return (
      keyId: '${res['keyId']}',
      providerOrderId: '${res['providerOrderId']}',
      amountPaise: (res['amountPaise'] as num).round(),
    );
  }

  Future<void> razorpayVerify({
    required String orderId,
    required String razorpayOrderId,
    required String razorpayPaymentId,
    required String signature,
  }) =>
      _api.post('/api/payments/razorpay/verify', {
        'orderId': orderId,
        'razorpayOrderId': razorpayOrderId,
        'razorpayPaymentId': razorpayPaymentId,
        'signature': signature,
      });
}
