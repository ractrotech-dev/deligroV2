// The restaurant card swipes sideways through the kitchen's dishes (like Zomato
// and Swiggy): page one is the restaurant, then one page per dish with its name
// and price. A card without dish photos, a closed shop and a rail card stay plain.
import 'package:deligro_customer/data/campaign_repository.dart';
import 'package:deligro_customer/models/restaurant.dart';
import 'package:deligro_customer/state/campaigns.dart';
import 'package:deligro_customer/state/prefs.dart';
import 'package:deligro_customer/state/providers.dart';
import 'package:deligro_customer/theme/app_theme.dart';
import 'package:deligro_customer/widgets/restaurant_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

final _client = SupabaseClient('http://localhost:1', 'test-key', authOptions: const AuthClientOptions(autoRefreshToken: false));

Restaurant _shop({bool open = true}) => Restaurant.fromRow({
      'id': 'r1', 'slug': 'spice-hub', 'name': 'Spice Hub', 'tagline': '', 'is_open': open, 'cuisines': ['Rolls'],
      'rating': 4.4, 'rating_count': 40, 'eta_min': 20, 'eta_max': 30, 'image_url': '', 'offer': '20% OFF',
      'menu_items': const [],
    });

MenuItem _dish(int i, {int price = 180, bool veg = true}) => MenuItem.fromRow({
      'id': 'd$i', 'external_id': 'e$i', 'name': 'Dish $i', 'description': '', 'price': price, 'discount_price': null,
      'veg': veg, 'available': true, 'category': 'Mains', 'image_url': 'https://example.invalid/d$i.jpg',
      'popular': false, 'bestseller': false,
    });

Future<void> _pump(WidgetTester tester, SharedPreferences prefs, Restaurant shop, List<MenuItem> dishes, {bool compact = false}) async {
  await tester.pumpWidget(ProviderScope(
    overrides: [
      prefsProvider.overrideWithValue(prefs),
      supabaseProvider.overrideWithValue(_client),
      livePlacementsProvider.overrideWith((_) async => LivePlacements.empty),
      dishPreviewProvider.overrideWith((_, _) async => dishes),
    ],
    child: MaterialApp(
      theme: buildTheme(Brightness.light),
      home: Scaffold(body: SizedBox(width: 360, child: RestaurantCard(restaurant: shop, compact: compact))),
    ),
  ));
  await tester.pump();
  await tester.pump();
}

void main() {
  setUpAll(() => GoogleFonts.config.allowRuntimeFetching = false);
  late SharedPreferences prefs;
  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    prefs = await SharedPreferences.getInstance();
  });

  testWidgets('swiping shows the first dish with its name and price, and the offer badge steps aside', (tester) async {
    await _pump(tester, prefs, _shop(), [_dish(1, price: 260), _dish(2)]);
    expect(find.text('20% OFF'), findsOneWidget);
    expect(find.text('Dish 1'), findsNothing);

    await tester.drag(find.byType(PageView), const Offset(-300, 0));
    await tester.pumpAndSettle();
    expect(find.text('Dish 1'), findsOneWidget);
    expect(find.text('₹260'), findsOneWidget);
    expect(find.text('20% OFF'), findsNothing);

    await tester.drag(find.byType(PageView), const Offset(-300, 0));
    await tester.pumpAndSettle();
    expect(find.text('Dish 2'), findsOneWidget);

    await tester.drag(find.byType(PageView), const Offset(300, 0));
    await tester.drag(find.byType(PageView), const Offset(300, 0));
    await tester.pumpAndSettle();
    expect(find.text('20% OFF'), findsOneWidget);
  });

  testWidgets('a card with no dish photos is a plain card', (tester) async {
    await _pump(tester, prefs, _shop(), const []);
    expect(find.byType(PageView), findsNothing);
    expect(find.text('Spice Hub'), findsOneWidget);
  });

  testWidgets('a closed shop and a rail card do not swipe', (tester) async {
    await _pump(tester, prefs, _shop(open: false), [_dish(1)]);
    expect(find.byType(PageView), findsNothing);
    expect(find.text('Closed now'), findsOneWidget);

    await _pump(tester, prefs, _shop(), [_dish(1)], compact: true);
    expect(find.byType(PageView), findsNothing);
  });
}
