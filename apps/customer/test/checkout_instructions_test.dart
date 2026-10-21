// Delivery instructions leave checkout as their own field, and the rider's
// arrival reaches the tracker. No network: the HTTP client is a recording fake
// and the providers that would reach Supabase are overridden.

import 'dart:convert';

import 'package:deligro_customer/core/api.dart';
import 'package:deligro_customer/core/pricing.dart';
import 'package:deligro_customer/data/checkout_repository.dart';
import 'package:deligro_customer/data/order_repository.dart';
import 'package:deligro_customer/features/checkout/checkout_screen.dart';
import 'package:deligro_customer/features/checkout/delivery_details.dart';
import 'package:deligro_customer/features/orders/orders_screen.dart';
import 'package:deligro_customer/models/address.dart';
import 'package:deligro_customer/models/order.dart';
import 'package:deligro_customer/models/restaurant.dart';
import 'package:deligro_customer/models/settings.dart';
import 'package:deligro_customer/models/tracking.dart';
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

const _orderRow = {
  'id': '3be2e4c7-46d6-4415-98a5-9b341acf17b9',
  'status': 'placed',
  'total': 413,
  'delivery_fee': 29,
  'tax_amount': 18,
  'tip': 0,
  'discount': 0,
  'payment_method': 'cod',
  'payment_status': 'pending',
  'created_at': '2026-10-21T08:00:00Z',
  'address': {'label': 'Home', 'line': 'House 12, Station Road'},
  'order_items': [],
  'restaurants': {'slug': 'sonna-da-dhaba', 'name': 'Sonna Da Dhaba', 'eta_min': 25},
};

void main() {
  group('delivery details', () {
    test('the instructions are the note, trimmed; blank is null', () {
      expect(deliveryInstructions('  ring twice  '), 'ring twice');
      expect(deliveryInstructions(''), isNull);
      expect(deliveryInstructions(' \n '), isNull);
    });

    test('the instructions are capped at what the server accepts (300)', () {
      expect(maxDeliveryInstructions, 300);
      expect(deliveryInstructions('a' * 300), hasLength(300));
      expect(deliveryInstructions('a' * 400), hasLength(300));
    });

    test('the address line carries the address details and never the note', () {
      final line = deliveryAddressLine(
        'House 12, Station Road',
        apartment: ' Flat 4B ',
        entry: '1234',
        floor: '2',
        building: 'Shanti Apts',
      );
      expect(line, 'House 12, Station Road, Flat 4B, Entry 1234, Floor 2, Shanti Apts');
      expect(deliveryAddressLine('House 12, Station Road'), 'House 12, Station Road');
    });
  });

  group('OrderRepository.place', () {
    late Map<String, dynamic> sent;
    late OrderRepository repo;

    setUp(() {
      final mock = MockClient((http.Request req) async {
        sent = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(jsonEncode({'order': _orderRow}), 201,
            headers: {'content-type': 'application/json'});
      });
      repo = OrderRepository(_client, ApiClient(_client.auth, client: mock));
    });

    Future<void> place({String? instructions}) => repo.place(
          restaurantSlug: 'sonna-da-dhaba',
          lines: [(itemId: 'e1', qty: 2)],
          addressLabel: 'Home',
          addressLine: 'House 12, Station Road',
          lat: 21.7,
          lng: 81.5,
          tip: 0,
          paymentMethod: 'cod',
          idempotencyKey: 'k1',
          instructions: instructions,
        );

    test('sends the instructions as their own field and the line as the address', () async {
      await place(instructions: 'Ring twice, dog in the yard');
      expect(sent['instructions'], 'Ring twice, dog in the yard');
      expect((sent['address'] as Map)['line'], 'House 12, Station Road');
    });

    test('sends no instructions key when there are none', () async {
      await place();
      expect(sent.containsKey('instructions'), isFalse);
    });
  });

  group('rider arrival', () {
    test('the tracker snapshot carries riderArrived', () {
      final snap = TrackingSnapshot.fromJson({
        'status': 'ON_THE_WAY',
        'riderArrived': true,
        'riderPositionSource': 'none',
      });
      expect(snap.riderArrived, isTrue);

      final older = TrackingSnapshot.fromJson({'status': 'ON_THE_WAY', 'riderPositionSource': 'none'});
      expect(older.riderArrived, isFalse);
    });

    test('on arrival the on-the-way step says so, in the push\'s words', () {
      final before = trackingSteps(riderName: 'Ravi');
      final after = trackingSteps(riderName: 'Ravi', riderArrived: true);
      expect(before[3].sub, 'Ravi is heading to you');
      expect(after[3].title, 'On the way');
      expect(after[3].sub, 'Your rider has arrived');
    });
  });

  group('proof of delivery', () {
    OrderRepository repoAnswering(int status, Map<String, dynamic> body) {
      final mock = MockClient((_) async => http.Response(jsonEncode(body), status,
          headers: {'content-type': 'application/json'}));
      return OrderRepository(_client, ApiClient(_client.auth, client: mock));
    }

    test('a 200 gives the signed link', () async {
      final repo = repoAnswering(200, {'url': 'https://x/signed?token=1', 'expiresIn': 600});
      expect(await repo.proofUrl('o1'), 'https://x/signed?token=1');
    });

    test('no photo (404), another customer (403) and a failure give no link', () async {
      expect(await repoAnswering(404, {'error': 'not_found'}).proofUrl('o1'), isNull);
      expect(await repoAnswering(403, {'error': 'forbidden'}).proofUrl('o1'), isNull);
      expect(await repoAnswering(503, {'error': 'migration_pending'}).proofUrl('o1'), isNull);
    });
  });

  group('the checkout screen', () {
    late List<Map<String, Object?>> placed;

    setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);

    setUp(() async {
      placed = [];
      SharedPreferences.setMockInitialValues({
        'deligro-cart': '{"slug":"sonna-da-dhaba","restaurantName":"Sonna Da Dhaba","lines":['
            '{"itemId":"e1","name":"Chicken Biryani","price":190,"qty":2,"veg":false}]}',
      });
    });

    testWidgets('places the note as instructions and leaves the line as the address', (tester) async {
      tester.view.physicalSize = const Size(1080, 2340);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      final prefs = await SharedPreferences.getInstance();
      final api = ApiClient(_client.auth);
      await tester.pumpWidget(ProviderScope(
        overrides: [
          prefsProvider.overrideWithValue(prefs),
          supabaseProvider.overrideWithValue(_client),
          userIdProvider.overrideWithValue('u1'),
          settingsProvider.overrideWith((_) async => _settings),
          restaurantProvider.overrideWith((_, _) async => _shop),
          addressesProvider.overrideWith(_FakeAddresses.new),
          checkoutRepoProvider.overrideWithValue(_FakeCheckout(api)),
          orderRepoProvider.overrideWithValue(_RecordingOrders(_client, api, placed)),
        ],
        child: MaterialApp(theme: buildTheme(Brightness.light), home: const CheckoutScreen()),
      ));
      for (var i = 0; i < 6; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      // Open the sheet, fill one address detail and the note for the courier.
      await tester.tap(find.text('Delivery instructions'));
      await tester.pump(const Duration(milliseconds: 400));
      await tester.enterText(find.widgetWithText(TextField, 'Floor'), '2');
      await tester.enterText(
        find.widgetWithText(TextField, 'Instructions for the courier'),
        'Ring twice, dog in the yard',
      );
      // Close the sheet by tapping the scrim above it.
      await tester.tapAt(const Offset(180, 8));
      await tester.pump(const Duration(milliseconds: 500));

      await tester.tap(find.textContaining('Place order'));
      await tester.pump(const Duration(milliseconds: 100));

      expect(placed, hasLength(1));
      expect(placed.single['instructions'], 'Ring twice, dog in the yard');
      expect(placed.single['addressLine'], 'House 12, Station Road, Bemetara, Floor 2');
      expect(placed.single['addressLine'].toString().contains('dog in the yard'), isFalse);

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 6));
    });
  });
}

class _RecordingOrders extends OrderRepository {
  _RecordingOrders(super.db, super.api, this.placed);
  final List<Map<String, Object?>> placed;

  @override
  Future<Order> place({
    required String restaurantSlug,
    required List<({String itemId, int qty})> lines,
    required String addressLabel,
    required String addressLine,
    double? lat,
    double? lng,
    required int tip,
    required String paymentMethod,
    String? couponCode,
    required String idempotencyKey,
    String? instructions,
  }) async {
    placed.add({'addressLine': addressLine, 'instructions': instructions});
    // Stop the flow here: what was sent is the whole point of this test.
    throw ApiException(400, 'invalid_items');
  }
}

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
