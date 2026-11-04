// Admin → App features in the customer app: the switches from /api/me, what they
// hide, and that checkout still works with no address book. No network.

import 'dart:convert';

import 'package:deligro_customer/core/api.dart';
import 'package:deligro_customer/core/customer_features.dart';
import 'package:deligro_customer/core/pricing.dart';
import 'package:deligro_customer/data/account_repository.dart';
import 'package:deligro_customer/data/checkout_repository.dart';
import 'package:deligro_customer/features/checkout/checkout_screen.dart';
import 'package:deligro_customer/models/address.dart';
import 'package:deligro_customer/models/restaurant.dart';
import 'package:deligro_customer/models/settings.dart';
import 'package:deligro_customer/state/prefs.dart';
import 'package:deligro_customer/state/providers.dart';
import 'package:deligro_customer/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

final _client = SupabaseClient(
  'http://localhost:1',
  'test-key',
  authOptions: const AuthClientOptions(autoRefreshToken: false),
);

class _Fixed extends CustomerFeaturesNotifier {
  _Fixed(this.value);
  final CustomerFeatures value;
  @override
  CustomerFeatures build() => value;
}

/// Answers every call the same way and counts them.
class _CountingAccount extends AccountRepository {
  _CountingAccount() : super(_client, ApiClient(_client.auth));
  int addressCalls = 0;

  @override
  Future<List<SavedAddress>> addresses() async {
    addressCalls++;
    return const [];
  }
}

void main() {
  group('reading the switches', () {
    test('what the server says wins', () {
      final f = CustomerFeatures.fromMe({
        'role': 'customer',
        'features': {'customer.tips': false, 'customer.promo_codes': true},
      });
      expect(f.can(tipsFeature), isFalse);
      expect(f.can(promoCodesFeature), isTrue);
    });

    test('a guest gets the for-everyone values the same way', () {
      final f = CustomerFeatures.fromMe({
        'role': null,
        'features': {'customer.favorites': false},
      });
      expect(f.can(favoritesFeature), isFalse);
    });

    test('no answer leaves each feature at its default, so a blip takes nothing away', () {
      expect(CustomerFeatures.unknown.can(cancelFeature), isTrue);
      expect(CustomerFeatures.fromMe(const {'role': 'customer'}).can(cancelFeature), isTrue);
    });

    test('self pickup stays off unless the server says otherwise', () {
      expect(CustomerFeatures.unknown.can('customer.self_pickup'), isFalse);
    });

    test('the repository reads them from /api/me', () async {
      final mock = MockClient((req) async {
        expect(req.url.path, '/api/me');
        return http.Response(
          jsonEncode({
            'role': 'customer',
            'features': {'customer.reorder': false},
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final repo = AccountRepository(_client, ApiClient(_client.auth, client: mock));
      expect((await repo.features()).can(reorderFeature), isFalse);
    });

    test('a failed reload keeps the last answer', () async {
      final mock = MockClient((_) async => http.Response('{}', 500));
      final c = ProviderContainer(overrides: [
        supabaseProvider.overrideWithValue(_client),
        accountRepoProvider.overrideWithValue(AccountRepository(_client, ApiClient(_client.auth, client: mock))),
        customerFeaturesProvider.overrideWith(() => _Fixed(const CustomerFeatures({'customer.tips': false}))),
      ]);
      addTearDown(c.dispose);
      await c.read(customerFeaturesProvider.notifier).reload();
      expect(c.read(customerFeaturesProvider).can(tipsFeature), isFalse);
    });

    test('a deep link to a switched-off page goes back to Account', () {
      const off = CustomerFeatures({'customer.favorites': false, 'customer.saved_addresses': false});
      expect(featureRedirect('/profile/favorites', off), '/profile');
      expect(featureRedirect('/profile/addresses', off), '/profile');
      expect(featureRedirect('/profile/help', off), isNull);
      expect(featureRedirect('/profile/favorites', CustomerFeatures.unknown), isNull);
    });

    test('refused by the server, the customer reads the server\'s sentence', () {
      final e = ApiException(403, 'feature_disabled', message: 'Rider tips is turned off by Deligro admin. Remove it and try again.');
      expect(e.friendly, contains('Rider tips'));
    });
  });

  group('with no address book', () {
    late ProviderContainer c;
    late _CountingAccount account;

    setUp(() {
      account = _CountingAccount();
      c = ProviderContainer(overrides: [
        supabaseProvider.overrideWithValue(_client),
        userIdProvider.overrideWithValue('u1'),
        accountRepoProvider.overrideWithValue(account),
        customerFeaturesProvider.overrideWith(() => _Fixed(const CustomerFeatures({'customer.saved_addresses': false}))),
      ]);
      addTearDown(c.dispose);
    });

    test('an address typed for this order is usable, and nothing calls the server', () async {
      expect(await c.read(addressesProvider.future), isEmpty);
      final a = await c.read(addressesProvider.notifier).add(label: 'Home', line: 'House 12, Station Road', lat: 21.7, lng: 81.5);
      expect(a.pinned, isTrue);
      expect(c.read(addressesProvider).value!.single.id, a.id);
      await c.read(addressesProvider.notifier).updatePin(a.id, 21.8, 81.6);
      expect(c.read(addressesProvider).value!.single.lat, 21.8);
      await c.read(addressesProvider.notifier).remove(a.id);
      expect(c.read(addressesProvider).value, isEmpty);
      expect(account.addressCalls, 0);
    });
  });

  group('the checkout screen', () {
    setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

    Future<void> open(WidgetTester tester, CustomerFeatures features) async {
      tester.view.physicalSize = const Size(1080, 9000);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      SharedPreferences.setMockInitialValues({
        'deligro-cart': '{"slug":"sonna-da-dhaba","restaurantName":"Sonna Da Dhaba","lines":['
            '{"itemId":"e1","name":"Chicken Biryani","price":190,"qty":2,"veg":false}]}',
      });
      final prefs = await SharedPreferences.getInstance();
      await tester.pumpWidget(ProviderScope(
        overrides: [
          prefsProvider.overrideWithValue(prefs),
          supabaseProvider.overrideWithValue(_client),
          userIdProvider.overrideWithValue('u1'),
          customerFeaturesProvider.overrideWith(() => _Fixed(features)),
          settingsProvider.overrideWith((_) async => _settings),
          restaurantProvider.overrideWith((_, _) async => _shop),
          addressesProvider.overrideWith(_NoAddresses.new),
          checkoutRepoProvider.overrideWithValue(_FakeCheckout(ApiClient(_client.auth))),
        ],
        child: MaterialApp(theme: buildTheme(Brightness.light), home: const CheckoutScreen()),
      ));
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    testWidgets('tip and promo code show while they are on', (tester) async {
      await open(tester, CustomerFeatures.unknown);
      expect(find.text('Tip the courier?'), findsOneWidget);
      expect(find.text('Have a code?'), findsOneWidget);
    });

    testWidgets('and go when they are off', (tester) async {
      await open(tester, const CustomerFeatures({'customer.tips': false, 'customer.promo_codes': false}));
      expect(find.text('Tip the courier?'), findsNothing);
      expect(find.text('Have a code?'), findsNothing);
    });
  });
}

class _NoAddresses extends AddressesNotifier {
  @override
  Future<List<SavedAddress>> build() async => const [];
}

class _FakeCheckout extends CheckoutRepository {
  _FakeCheckout(super.api);
  @override
  Future<PaymentRules> paymentRules(String slug) async => const PaymentRules(true, false, 0);
}

final _shop = Restaurant.fromRow({
  'id': 'r1',
  'slug': 'sonna-da-dhaba',
  'name': 'Sonna Da Dhaba',
  'is_open': true,
  'cuisines': ['North Indian'],
  'rating': 4.6,
  'rating_count': 120,
  'eta_min': 25,
  'eta_max': 35,
  'lat': 21.716,
  'lng': 81.534,
  'menu_items': [
    {
      'id': 'u1',
      'external_id': 'e1',
      'name': 'Chicken Biryani',
      'price': 190,
      'veg': false,
      'available': true,
      'category': 'Mains',
    },
  ],
});

const _settings = PlatformSettings(
  charges: ChargesConfig(deliveryFee: 29, taxRate: 0.05, freeDeliveryThreshold: 499),
  minOrder: 0,
  acceptingOrders: true,
  maintenanceMessage: '',
  featureOnlinePayment: false,
  deliveryRadiusKm: 25,
  supportPhone: '+919999999999',
  supportEmail: 'support@deligro.app',
  supportWhatsapp: '919999999999',
  featureGrocery: true,
  featurePickDrop: false,
  featurePharmacy: false,
);
