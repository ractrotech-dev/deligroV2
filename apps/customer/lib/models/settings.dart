import '../core/pricing.dart';

/// The `platform_settings` row (id = true) — every column here is granted to
/// anon/authenticated (migration 0045).
class PlatformSettings {
  const PlatformSettings({
    required this.charges,
    required this.minOrder,
    required this.acceptingOrders,
    required this.maintenanceMessage,
    required this.featureOnlinePayment,
    required this.deliveryRadiusKm,
    required this.supportPhone,
    required this.supportEmail,
    required this.supportWhatsapp,
    required this.featureGrocery,
    required this.featurePickDrop,
    required this.featurePharmacy,
  });

  final ChargesConfig charges;
  final int minOrder;
  final bool acceptingOrders;
  final String maintenanceMessage;
  final bool featureOnlinePayment;
  final double deliveryRadiusKm;
  final String supportPhone;
  final String supportEmail;
  final String supportWhatsapp;
  final bool featureGrocery;
  final bool featurePickDrop;
  final bool featurePharmacy;

  static const columns =
      'delivery_fee, tax_rate, free_delivery_threshold, min_order, '
      'accepting_orders, maintenance_message, feature_online_payment, '
      'delivery_radius_km, support_phone, support_email, support_whatsapp, '
      'feature_grocery, feature_pick_drop, feature_pharmacy';

  static const defaults = PlatformSettings(
    charges: ChargesConfig.defaults,
    minOrder: 0,
    acceptingOrders: true,
    maintenanceMessage: '',
    featureOnlinePayment: false,
    deliveryRadiusKm: 25,
    supportPhone: '',
    supportEmail: '',
    supportWhatsapp: '',
    featureGrocery: true,
    featurePickDrop: false,
    featurePharmacy: false,
  );

  factory PlatformSettings.fromRow(Map<String, dynamic> r) {
    num n(String k, num d) => r[k] is num ? r[k] as num : num.tryParse('${r[k]}') ?? d;
    return PlatformSettings(
      charges: ChargesConfig(
        deliveryFee: n('delivery_fee', 29).round(),
        taxRate: n('tax_rate', 0.05).toDouble(),
        freeDeliveryThreshold: n('free_delivery_threshold', 0).round(),
      ),
      minOrder: n('min_order', 0).round(),
      acceptingOrders: r['accepting_orders'] != false,
      maintenanceMessage: '${r['maintenance_message'] ?? ''}',
      featureOnlinePayment: r['feature_online_payment'] == true,
      deliveryRadiusKm: n('delivery_radius_km', 25).toDouble(),
      supportPhone: '${r['support_phone'] ?? ''}',
      supportEmail: '${r['support_email'] ?? ''}',
      supportWhatsapp: '${r['support_whatsapp'] ?? ''}',
      featureGrocery: r['feature_grocery'] != false,
      featurePickDrop: r['feature_pick_drop'] == true,
      featurePharmacy: r['feature_pharmacy'] == true,
    );
  }
}
