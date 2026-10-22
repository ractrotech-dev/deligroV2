// Every place a notification tap can lead must exist on the real router
// (router.dart with every phase merged), and the translation from what the
// server sends must land on one of them. No network: the Supabase client is
// never asked for anything and the router is only matched against, not shown.
import 'dart:async';

import 'package:deligro_rider/core/push_routes.dart';
import 'package:deligro_rider/core/update_check.dart';
import 'package:deligro_rider/models/rider_me.dart';
import 'package:deligro_rider/router.dart';
import 'package:deligro_rider/state/prefs.dart';
import 'package:deligro_rider/state/providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/testing.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

void main() {
  late ProviderContainer container;
  late SupabaseClient supabase;

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    supabase = SupabaseClient(
      'http://localhost:1',
      'test-key',
      httpClient: MockClient((_) async => http.Response('{}', 500)),
      authOptions: const AuthClientOptions(autoRefreshToken: false),
    );
    container = ProviderContainer(
      overrides: [
        prefsProvider.overrideWithValue(await SharedPreferences.getInstance()),
        supabaseProvider.overrideWithValue(supabase),
        meProvider.overrideWith((_) => Completer<RiderMe>().future),
        updateProvider.overrideWith((_) => Completer<AppUpdate?>().future),
      ],
    );
  });

  tearDown(() {
    container.dispose();
    unawaited(supabase.dispose());
  });

  bool exists(String path) =>
      !container.read(routerProvider).configuration.findMatch(Uri.parse(path)).isError;

  test('every page a tap can open is on the router', () {
    const targets = [
      '/home',
      '/jobs',
      '/earnings',
      '/earnings/payouts',
      '/earnings/incentives',
      '/history',
      '/history/order/o1',
      '/more',
      '/more/cash',
      '/more/performance',
      '/more/profile',
      '/more/profile/documents',
      '/more/help',
      '/more/help/new',
      '/more/help/tickets/t1',
      '/notifications',
      '/safety',
    ];
    final missing = [for (final t in targets) if (!exists(t)) t];
    expect(missing, isEmpty);
  });

  test('what the server sends lands on a page that exists', () {
    String go({String? category, String? url, Map<String, dynamic> data = const {}}) =>
        routeForNotification(category: category, url: url, data: data, exists: exists);

    final cases = <(String, String)>[
      (go(url: '/more/cash'), '/more/cash'),
      (go(category: 'cash'), '/more/cash'),
      (go(url: '/cash'), '/more/cash'),
      (go(url: '/more/profile'), '/more/profile'),
      (go(category: 'documents'), '/more/profile/documents'),
      (go(url: '/documents'), '/more/profile/documents'),
      (go(url: '/more/performance'), '/more/performance'),
      (go(url: '/help'), '/more/help'),
      (go(url: '/help/tickets/t1'), '/more/help/tickets/t1'),
      (go(category: 'support', data: {'ticketId': 't1'}), '/more/help/tickets/t1'),
      (go(url: '/notifications'), '/notifications'),
      (go(url: '/safety'), '/safety'),
      (go(category: 'safety'), '/safety'),
      (go(url: '/earnings/payouts'), '/earnings/payouts'),
      (go(category: 'payouts'), '/earnings'),
      (go(url: '/jobs/o1'), '/jobs'),
      (go(url: '/jobs/o1', data: {'orderId': 'o1', 'finished': true}), '/history/order/o1'),
      (go(category: 'delivery_updates', data: {'orderId': 'o1', 'outcome': 'delivered'}), '/history/order/o1'),
      (go(url: 'https://example.com/x'), '/notifications'),
    ];
    for (final (actual, expected) in cases) {
      expect(actual, expected);
      expect(exists(actual), isTrue, reason: '$actual is not on the router');
    }
  });
}
