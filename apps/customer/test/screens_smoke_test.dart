// Renders every main screen at phone size, light and dark, against fake
// data, and fails on any exception or layout overflow. No network: the
// providers that would hit Supabase or the API are overridden.

import 'package:deligro_customer/core/pricing.dart';
import 'package:deligro_customer/data/checkout_repository.dart';
import 'package:deligro_customer/features/auth/login_screen.dart';
import 'package:deligro_customer/features/checkout/checkout_screen.dart';
import 'package:deligro_customer/features/home/home_screen.dart';
import 'package:deligro_customer/features/orders/orders_screen.dart';
import 'package:deligro_customer/features/orders/tracking_screen.dart';
import 'package:deligro_customer/features/profile/profile_screen.dart';
import 'package:deligro_customer/features/restaurant/restaurant_screen.dart';
import 'package:deligro_customer/features/search/search_screen.dart';
import 'package:deligro_customer/features/stores/stores_screen.dart';
import 'package:deligro_customer/core/api.dart';
import 'package:deligro_customer/data/account_repository.dart';
import 'package:deligro_customer/data/order_repository.dart';
import 'package:deligro_customer/models/address.dart';
import 'package:deligro_customer/models/order.dart';
import 'package:deligro_customer/models/restaurant.dart';
import 'package:deligro_customer/models/settings.dart';
import 'package:deligro_customer/models/tracking.dart';
import 'package:deligro_customer/state/cart.dart';
import 'package:deligro_customer/state/prefs.dart';
import 'package:deligro_customer/state/providers.dart';
import 'package:deligro_customer/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

final _shop = Restaurant.fromRow({
  'id': 'r1',
  'slug': 'sonna-da-dhaba',
  'name': 'Sonna Da Dhaba with a rather long name that must ellipsize',
  'tagline': 'North Indian · Tandoor',
  'is_open': true,
  'cuisines': ['North Indian', 'Biryani'],
  'rating': 4.6,
  'rating_count': 120,
  'eta_min': 25,
  'eta_max': 35,
  'lat': 21.716,
  'lng': 81.534,
  'offer': '20% OFF',
  'image_url': '',
  'menu_items': [
    for (var i = 0; i < 12; i++)
      {
        'id': 'u$i',
        'external_id': 'e$i',
        'name': i.isEven ? 'Paneer Butter Masala Special Family Pack $i' : 'Chicken Biryani $i',
        'description': 'Slow-cooked, rich and creamy. Serves two generously with naan.',
        'price': 180 + i * 10,
        'discount_price': i % 3 == 0 ? 150 : null,
        'veg': i.isEven,
        'available': i != 5,
        'category': i < 6 ? 'Mains' : 'Rice & Biryani',
        'popular': i < 3,
      },
  ],
});

final _closed = Restaurant.fromRow({
  'id': 'r2',
  'slug': 'closed-cafe',
  'name': 'Closed Cafe',
  'is_open': false,
  'cuisines': ['Bakery'],
  'rating': 0,
  'rating_count': 0,
});

final _order = Order.fromRow({
  'id': '3be2e4c7-46d6-4415-98a5-9b341acf17b9',
  'status': 'on_the_way',
  'total': 413,
  'delivery_fee': 29,
  'tax_amount': 18,
  'tip': 20,
  'discount': 0,
  'payment_method': 'cod',
  'payment_status': 'pending',
  'created_at': DateTime.now().toUtc().toIso8601String(),
  'address': {'label': 'Home', 'line': 'House 12, Station Road, Bemetara'},
  'order_items': [
    {'name': 'Chicken Biryani', 'qty': 2, 'price': 173, 'menu_items': {'external_id': 'e1', 'veg': false}},
  ],
  'restaurants': {'slug': 'sonna-da-dhaba', 'name': 'Sonna Da Dhaba', 'eta_min': 25},
});

const _settings = PlatformSettings(
  charges: ChargesConfig(deliveryFee: 29, taxRate: 0.05, freeDeliveryThreshold: 499),
  minOrder: 0,
  acceptingOrders: true,
  maintenanceMessage: '',
  featureOnlinePayment: true,
  deliveryRadiusKm: 25,
  supportPhone: '+919999999999',
  supportEmail: 'support@deligro.app',
  supportWhatsapp: '919999999999',
  featureGrocery: true,
  featurePickDrop: false,
  featurePharmacy: false,
);

class _FakeAddresses extends AddressesNotifier {
  @override
  Future<List<SavedAddress>> build() async => const [
        SavedAddress(
          id: 'a1',
          label: 'Home',
          line: 'House 12, Station Road, Bemetara',
          lat: 21.7157,
          lng: 81.5335,
          isDefault: true,
        ),
      ];
}

class _FakeCheckout extends CheckoutRepository {
  _FakeCheckout(super.api);
  @override
  Future<Serviceability> serviceability(String slug, double lat, double lng) async =>
      const Serviceability('in_range', 1.2, 25, null);
  @override
  Future<PaymentRules> paymentRules(String slug) async => const PaymentRules(true, true, 300);
}

class _FakeOrders extends OrderRepository {
  _FakeOrders(super.db, super.api);
  @override
  Future<List<Order>> myOrders({List<String>? statuses, int limit = 30}) async => [_order];
  @override
  Future<TrackingSnapshot> tracking(String orderId) async => TrackingSnapshot.fromJson({
        'status': 'ON_THE_WAY',
        'eta': {'minutesRemaining': 9, 'late': false, 'lateByMinutes': 0},
        'rider': {'name': 'Ravi Kumar', 'id': 'AB12CD34', 'phone': '+919999999999'},
        'restaurant': null,
        'destination': null,
        'riderPositionSource': 'none',
      });
  @override
  Future<String?> deliveryCode(String orderId) async => '4821';
}

class _FakeAccount extends AccountRepository {
  _FakeAccount(super.db, super.api);
  @override
  Future<Profile?> profile() async => Profile(
        id: 'u1',
        fullName: 'Asha Verma',
        phone: '+919876543210',
        avatarUrl: null,
        role: 'customer',
        createdAt: DateTime(2026, 8, 1),
      );
}

late SharedPreferences _prefs;
final _client = SupabaseClient(
  'http://localhost:1',
  'test-key',
  authOptions: const AuthClientOptions(autoRefreshToken: false),
);

Future<void> _pump(
  WidgetTester tester,
  Widget screen, {
  Brightness b = Brightness.light,
  double textScale = 1,
}) async {
  tester.view.physicalSize = const Size(1080, 2340);
  tester.view.devicePixelRatio = 3; // a 360×780 phone
  addTearDown(tester.view.reset);

  final api = ApiClient(_client.auth);
  await tester.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(_prefs),
      supabaseProvider.overrideWithValue(_client),
      userIdProvider.overrideWithValue('u1'),
      settingsProvider.overrideWith((_) async => _settings),
      restaurantsProvider.overrideWith((_) async => [_shop, _closed]),
      searchCatalogProvider.overrideWith((_) async => [_shop, _closed]),
      restaurantProvider.overrideWith((_, _) async => _shop),
      homeBannersProvider.overrideWith((_) async => const []),
      categoryImagesProvider.overrideWith((_) async => const {}),
      activeOrderProvider.overrideWith((_) async => _order),
      myOrdersProvider.overrideWith((_) async => [_order]),
      orderProvider.overrideWith((_, _) async => _order),
      favoritesProvider.overrideWith((_) async => [_shop]),
      isFavoriteProvider.overrideWith((_, _) async => true),
      addressesProvider.overrideWith(_FakeAddresses.new),
      checkoutRepoProvider.overrideWithValue(_FakeCheckout(api)),
      orderRepoProvider.overrideWithValue(_FakeOrders(_client, api)),
      accountRepoProvider.overrideWithValue(_FakeAccount(_client, api)),
    ],
    child: MaterialApp(
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: b == Brightness.light ? ThemeMode.light : ThemeMode.dark,
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: screen,
    ),
  ));
  // Let the fake futures resolve; avoid pumpAndSettle (spinners/timers).
  for (var i = 0; i < 6; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  setUpAll(() {
    GoogleFonts.config.allowRuntimeFetching = false;
  });

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    _prefs = await SharedPreferences.getInstance();
  });

  final screens = <String, Widget Function()>{
    'login': () => const LoginScreen(),
    'home': () => const HomeScreen(),
    'stores': () => const StoresScreen(),
    'search': () => const SearchScreen(query: 'biryani'),
    'restaurant': () => const RestaurantScreen(slug: 'sonna-da-dhaba'),
    'checkout (with basket)': () => const CheckoutScreen(),
    'orders': () => const OrdersScreen(),
    'tracking': () => const TrackingScreen(orderId: '3be2e4c7-46d6-4415-98a5-9b341acf17b9'),
    'profile': () => const ProfileScreen(),
  };

  // Light, dark, and light with large system text (common on Android).
  final variants = [
    (Brightness.light, 1.0, 'light'),
    (Brightness.dark, 1.0, 'dark'),
    (Brightness.light, 1.3, 'large text'),
  ];
  for (final (b, scale, name) in variants) {
    for (final entry in screens.entries) {
      testWidgets('${entry.key} renders ($name)', (tester) async {
        if (entry.key.startsWith('checkout')) {
          _prefs.setString(
            'deligro-cart',
            '{"slug":"sonna-da-dhaba","restaurantName":"Sonna Da Dhaba","lines":['
                '{"itemId":"e1","name":"Chicken Biryani","price":190,"qty":2,"veg":false}]}',
          );
        }
        final errors = <String>[];
        final original = FlutterError.onError;
        FlutterError.onError = (d) {
          errors.add(d.toStringShort());
          debugPrint(d.toString());
          original?.call(d);
        };
        addTearDown(() => FlutterError.onError = original);
        await _pump(tester, entry.value(), b: b, textScale: scale);
        expect(tester.takeException(), isNull, reason: errors.join(' | '));
        // Dispose so polling/carousel timers are cancelled.
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 6));
      });
    }
  }

  testWidgets('cart state survives into checkout bill', (tester) async {
    _prefs.setString(
      'deligro-cart',
      '{"slug":"sonna-da-dhaba","restaurantName":"Sonna Da Dhaba","lines":['
          '{"itemId":"e1","name":"Chicken Biryani","price":190,"qty":2,"veg":false}]}',
    );
    await _pump(tester, const CheckoutScreen());
    expect(find.textContaining('Chicken Biryani'), findsWidgets);
    expect(find.textContaining('₹380'), findsWidgets);
    expect(maxQty, 50);
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  });
}
