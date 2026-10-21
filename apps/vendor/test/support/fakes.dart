import 'package:deligro_partner/data/orders_repository.dart';
import 'package:deligro_partner/models/order.dart';
import 'package:deligro_partner/models/vendor_me.dart';
import 'package:deligro_partner/state/orders.dart';
import 'package:deligro_partner/state/prefs.dart';
import 'package:deligro_partner/state/providers.dart';
import 'package:deligro_partner/state/session.dart';
import 'package:deligro_partner/theme/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:mocktail/mocktail.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class MockOrdersRepo extends Mock implements OrdersRepository {}

VendorMe fakeMe({Map<String, bool> features = const {'vendor.reject_orders': true}, int shops = 1}) => VendorMe(
  profileId: 'u1',
  fullName: 'Asha Verma',
  phone: '+919876543210',
  role: 'restaurant',
  shops: [
    const Shop(id: 's1', slug: 'spice-hub', name: 'Spice Hub Restaurant', isOpen: true, prepMinutes: 20),
    if (shops > 1) const Shop(id: 's2', slug: 'chai-point', name: 'Chai Point', isOpen: false),
  ],
  activeSlug: 'spice-hub',
  features: features,
);

class FixedMe extends VendorMeNotifier {
  FixedMe(this.me);
  final VendorMe me;
  @override
  Future<VendorMe?> build() async => me;
}

final _now = DateTime.now().toUtc();

Map<String, dynamic> fakeOrderJson(
  String id, {
  String status = 'placed',
  String? preparingAt,
  String name = 'Asha Verma',
  int minutesAgo = 4,
  String? cancellationReason,
  String? pickupOtp,
  String? rider,
  List<Map<String, dynamic>> events = const [],
}) => {
  'id': id,
  'code': '#D-${id.substring(0, 4).toUpperCase()}',
  'status': status,
  'preparingAt': preparingAt,
  'createdAt': _now.subtract(Duration(minutes: minutesAgo)).toIso8601String(),
  'customerProfile': {'name': name, 'phone': '+919876543210', 'initials': 'AV'},
  'area': 'Home',
  'deliveryLine': 'House 12, Station Road, Bemetara',
  'lines': [
    {'name': 'Paneer Tikka', 'qty': 2, 'price': 180},
    {'name': 'Garlic Naan', 'qty': 2, 'price': 40},
    {'name': 'Cold Coffee', 'qty': 1, 'price': 90},
  ],
  'total': 553,
  'itemsSubtotal': 530,
  'deliveryFee': 29,
  'taxAmount': 27,
  'tip': 10,
  'discount': 43,
  'couponCode': 'FLAT10',
  'discountFundedBy': 'vendor',
  'paymentMethod': 'cod',
  'paymentStatus': 'pending',
  'acceptedAt': status == 'placed' ? null : _now.subtract(Duration(minutes: minutesAgo - 1)).toIso8601String(),
  'prepMinutes': status == 'placed' ? null : 20,
  'cancellationReason': cancellationReason,
  'pickupOtp': pickupOtp,
  'rider': rider == null ? null : {'name': rider, 'stage': 'assigned'},
  'events': events,
};

VendorOrder fakeOrder(
  String id, {
  String status = 'placed',
  String? preparingAt,
  String name = 'Asha Verma',
  int minutesAgo = 4,
}) => VendorOrder.fromJson(
  fakeOrderJson(id, status: status, preparingAt: preparingAt, name: name, minutesAgo: minutesAgo),
);

/// A board with one order in each live stage.
List<VendorOrder> fakeBoard() => [
  fakeOrder('aa11aa11-0000-0000-0000-000000000001', name: 'Asha Verma', minutesAgo: 2),
  fakeOrder('bb22bb22-0000-0000-0000-000000000002', status: 'kitchen', name: 'Ravi Kumar', minutesAgo: 9),
  fakeOrder(
    'cc33cc33-0000-0000-0000-000000000003',
    status: 'kitchen',
    preparingAt: _now.toIso8601String(),
    name: 'Neha Sahu',
    minutesAgo: 14,
  ),
  fakeOrder('dd44dd44-0000-0000-0000-000000000004', status: 'ready', name: 'Imran Khan', minutesAgo: 25),
  fakeOrder('ee55ee55-0000-0000-0000-000000000005', status: 'on_the_way', name: 'Pooja Verma', minutesAgo: 40),
];

/// Pumps [child] (or the app's router when [router] is set) with the
/// Partner app's providers faked.
Future<ProviderContainer> pumpPartner(
  WidgetTester t, {
  Widget? child,
  GoRouterBuilder? router,
  required List<Override> overrides,
  Brightness b = Brightness.light,
  double scale = 1,
}) async {
  // main() does this in the app.
  await initializeDateFormatting('en_IN');
  t.view.physicalSize = const Size(1080, 2340);
  t.view.devicePixelRatio = 3; // a 360×780 phone
  addTearDown(t.view.reset);
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();
  final container = ProviderContainer(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      supabaseProvider.overrideWithValue(
        SupabaseClient('http://localhost:1', 'test-key', authOptions: const AuthClientOptions(autoRefreshToken: false)),
      ),
      signedInProvider.overrideWithValue(true),
      ...overrides,
    ],
  );
  _live = container;
  addTearDown(_disposeLive);
  Widget wrap(Widget? c) => MediaQuery(
    data: MediaQueryData.fromView(t.view).copyWith(textScaler: TextScaler.linear(scale)),
    child: c!,
  );
  await t.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: router != null
          ? Consumer(
              builder: (_, ref, _) => MaterialApp.router(
                debugShowCheckedModeBanner: false,
                theme: buildTheme(b),
                routerConfig: router(ref),
                builder: (_, c) => wrap(c),
              ),
            )
          : MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildTheme(b),
              builder: (_, c) => wrap(c),
              home: child,
            ),
    ),
  );
  for (var i = 0; i < 5; i++) {
    await t.pump(const Duration(milliseconds: 100));
  }
  return container;
}

typedef GoRouterBuilder = RouterConfig<Object> Function(WidgetRef ref);

List<Override> ordersOverrides(MockOrdersRepo repo, {VendorMe? me}) => [
  ordersRepoProvider.overrideWithValue(repo),
  vendorMeProvider.overrideWith(() => FixedMe(me ?? fakeMe())),
];

ProviderContainer? _live;

void _disposeLive() {
  _live?.dispose();
  _live = null;
}

/// [testWidgets] that unmounts the app and disposes its providers at the end,
/// so self-refreshing providers (the board's 8 s poll) cancel their timers
/// before the framework checks for leftovers. (In the app the provider scope
/// stays mounted and auto-dispose does this; a test that removes the scope
/// leaves nothing to drive it.)
void testPartner(String description, Future<void> Function(WidgetTester t) body) => testWidgets(description, (t) async {
  try {
    await body(t);
  } finally {
    await t.pumpWidget(const SizedBox());
    _disposeLive();
    await t.pump(const Duration(seconds: 10));
  }
});
