import 'dart:convert';

import 'package:deligro_customer/core/api.dart';
import 'package:deligro_customer/core/push.dart';
import 'package:deligro_customer/data/campaign_repository.dart';
import 'package:deligro_customer/data/order_repository.dart';
import 'package:deligro_customer/models/banner.dart';
import 'package:deligro_customer/models/order.dart';
import 'package:deligro_customer/state/campaigns.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

final _client = SupabaseClient(
  'http://localhost:1',
  'test-key',
  authOptions: const AuthClientOptions(autoRefreshToken: false),
);

Map<String, dynamic> _row(Map<String, dynamic>? menuItem) => {
      'id': 'o1',
      'status': 'delivered',
      'total': 100,
      'order_items': [
        {'name': 'Thali', 'qty': 1, 'price': 100, 'menu_items': menuItem},
      ],
      'restaurants': {'slug': 's', 'name': 'S'},
    };

PromoBanner _banner(String type, [String? value]) =>
    PromoBanner.fromRow({'id': 'b1', 'headline': 'H', 'target_type': type, 'target_value': value});

class _Recording extends CampaignRepository {
  _Recording() : super(ApiClient(_client.auth));
  final sent = <String>[];

  @override
  Future<void> trackBanner(String bannerId, String kind, String placement) async => sent.add('$kind:$bannerId:$placement');
}

void main() {
  group('Order again', () {
    test('a dish the shop added itself has no external id: its uuid is the id', () {
      final o = Order.fromRow(_row({'id': 'uuid-1', 'external_id': null, 'veg': true}));
      expect(o.lines.single.itemId, 'uuid-1');
    });

    test('an external id still wins, as on the menu', () {
      final o = Order.fromRow(_row({'id': 'uuid-1', 'external_id': 'b-1', 'veg': true}));
      expect(o.lines.single.itemId, 'b-1');
    });

    test('a dish since deleted stays empty, so it is shown as gone', () {
      expect(Order.fromRow(_row(null)).lines.single.itemId, '');
    });

    test('the order query asks for the id', () {
      expect(Order.columns, contains('menu_items(id, external_id, veg)'));
    });
  });

  group('banners', () {
    test('a pharmacy banner has somewhere to go', () {
      expect(_banner('pharmacy').route, '/stores?category=pharmacy');
    });

    test('a link type the app has no page for stays untappable', () {
      expect(_banner('membership').route, isNull);
      expect(_banner('external', 'javascript:alert(1)').route, isNull);
    });

    test('one impression per banner, every tap', () {
      final repo = _Recording();
      final t = BannerTracker(repo);
      t.impression('b1', 'home_hero');
      t.impression('b1', 'home_hero');
      t.impression('b2', 'home_hero');
      t.click('b1', 'home_hero');
      t.click('b1', 'home_hero');
      expect(repo.sent, [
        'impression:b1:home_hero',
        'impression:b2:home_hero',
        'click:b1:home_hero',
        'click:b1:home_hero',
      ]);
    });

    test('tracking posts what the route reads, and a failure never surfaces', () async {
      late Map<String, dynamic> body;
      late String path;
      var fail = false;
      final repo = CampaignRepository(ApiClient(
        _client.auth,
        client: MockClient((req) async {
          if (fail) throw Exception('offline');
          path = req.url.path;
          body = jsonDecode(req.body) as Map<String, dynamic>;
          return http.Response('{"ok":true}', 200, headers: {'content-type': 'application/json'});
        }),
      ));
      await repo.trackBanner('b1', 'click', 'home_hero');
      expect(path, '/api/banners/track');
      expect(body, {'bannerId': 'b1', 'kind': 'click', 'placement': 'home_hero'});
      fail = true;
      await repo.trackBanner('b1', 'click', 'home_hero');
    });
  });

  group('push taps', () {
    test('an order opens its order', () {
      expect(pushPathFrom('/orders/abcdef12', null), '/orders/abcdef12');
    });

    test('a support reply opens Help', () {
      expect(pushPathFrom(null, {'url': '/support'}), '/profile/help');
    });

    test('anything else only opens the app', () {
      for (final link in ['/offers', '/profile/membership', '/no/such/page', 'https://evil.example/support']) {
        expect(pushPathFrom(link, null), isNull, reason: link);
      }
      expect(pushPathFrom(null, null), isNull);
      expect(pushPathFrom(null, {'url': 42}), isNull);
    });
  });

  group('the real total', () {
    Future<(Map<String, dynamic>, Object?)> place(int status, Map<String, dynamic> answer) async {
      late Map<String, dynamic> sent;
      final repo = OrderRepository(
        _client,
        ApiClient(
          _client.auth,
          client: MockClient((req) async {
            sent = jsonDecode(req.body) as Map<String, dynamic>;
            return http.Response(jsonEncode(answer), status, headers: {'content-type': 'application/json'});
          }),
        ),
      );
      Object? error;
      try {
        await repo.place(
          restaurantSlug: 's',
          lines: [(itemId: 'e1', qty: 1, variantId: null, addonIds: const <String>[])],
          addressLabel: 'Home',
          addressLine: 'House 12',
          tip: 0,
          paymentMethod: 'cod',
          idempotencyKey: 'k1',
          expectedTotal: 129,
        );
      } catch (e) {
        error = e;
      }
      return (sent, error);
    }

    test('the total on screen goes with the order', () async {
      final (sent, _) = await place(201, {'order': _row(null)});
      expect(sent['expectedTotal'], 129);
    });

    test('a refusal carries the real bill', () async {
      final bill = {'subtotal': 100, 'deliveryFee': 39, 'taxes': 5, 'tip': 0, 'discount': 0, 'total': 144};
      final (_, error) = await place(409, {'error': 'total_changed', 'bill': bill});
      expect(error, isA<ApiException>().having((e) => e.code, 'code', 'total_changed').having((e) => e.body['bill'], 'bill', bill));
    });
  });
}
