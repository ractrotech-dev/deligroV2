/// Display-side copies of the website's money rules. The server re-prices
/// every order (`/api/orders` → `createOrder`), so these only preview a bill;
/// the 201 response is the real one. Keep them in step with
/// `src/lib/pricing.ts` and `src/lib/orders/kitchen-pace.ts`.
library;

/// Whole rupees, as everywhere outside Razorpay.
const tipOptions = [0, 20, 30, 50];
const _maxTip = 50;

class ChargesConfig {
  const ChargesConfig({
    required this.deliveryFee,
    required this.taxRate,
    required this.freeDeliveryThreshold,
  });

  final int deliveryFee;

  /// A fraction, e.g. 0.05.
  final double taxRate;

  /// Subtotal at/above which delivery is free. 0 = never free.
  final int freeDeliveryThreshold;

  static const defaults = ChargesConfig(
    deliveryFee: 29,
    taxRate: 0.05,
    freeDeliveryThreshold: 0,
  );
}

class OrderCharges {
  const OrderCharges({
    required this.subtotal,
    required this.deliveryFee,
    required this.taxes,
    required this.tip,
    required this.discount,
    required this.total,
  });

  final int subtotal;
  final int deliveryFee;
  final int taxes;
  final int tip;
  final int discount;
  final int total;
}

OrderCharges computeCharges(
  ChargesConfig config,
  int subtotal, {
  num tip = 0,
  int discount = 0,
}) {
  final qualifiesFree = config.freeDeliveryThreshold > 0 &&
      subtotal >= config.freeDeliveryThreshold;
  final fee = subtotal > 0 && !qualifiesFree ? config.deliveryFee : 0;
  final taxes = (subtotal * config.taxRate).round();
  final safeTip = tip.isFinite ? tip.round().clamp(0, _maxTip) : 0;
  final gross = subtotal + fee + taxes + safeTip;
  return OrderCharges(
    subtotal: subtotal,
    deliveryFee: fee,
    taxes: taxes,
    tip: safeTip,
    discount: discount,
    total: (gross - discount).clamp(0, gross),
  );
}

/// `discount_price` is charged only when set, non-negative and lower.
int effectivePrice(int price, int? discountPrice) {
  if (discountPrice != null && discountPrice >= 0 && discountPrice < price) {
    return discountPrice;
  }
  return price;
}

class KitchenPace {
  const KitchenPace(this.etaMin, this.etaMax, this.busy, this.addedMinutes, {this.weatherMinutes = 0});
  final int etaMin;
  final int etaMax;
  final bool busy;
  final int addedMinutes;

  /// Minutes added for rain or a storm in the shop's zone (0178).
  final int weatherMinutes;
}

const _fallbackEtaMin = 25;
const _fallbackEtaMax = 35;
const _maxBusyExtra = 120;

/// The band a shop is quoting right now, live busy bump included.
KitchenPace kitchenPace({
  int? etaMin,
  int? etaMax,
  DateTime? busyUntil,
  int? busyExtraMinutes,
  int? weatherExtraMinutes,
  DateTime? now,
}) {
  final at = now ?? DateTime.now();
  final baseMin = etaMin != null && etaMin > 0 ? etaMin : _fallbackEtaMin;
  final rawMax = etaMax != null && etaMax > 0 ? etaMax : _fallbackEtaMax;
  final baseMax = rawMax < baseMin ? baseMin : rawMax;
  final live = busyUntil != null && busyUntil.isAfter(at);
  final extra = live ? (busyExtraMinutes ?? 0).clamp(0, _maxBusyExtra) : 0;
  final weather = (weatherExtraMinutes ?? 0).clamp(0, 60);
  return KitchenPace(baseMin + extra + weather, baseMax + extra + weather, extra > 0, extra, weatherMinutes: weather);
}
